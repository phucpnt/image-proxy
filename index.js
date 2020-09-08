const http = require("http");
const sharp = require("sharp");
const URL = require("url");
const aws = require("aws-sdk");
const log = require("debug")("image-proxy");

const PORT = process.env.PORT || 16101;
const S3_PATH_WATERMARK = process.env.S3_PATH_WATERMARK;
const S3_PREFIX_PROXIED = process.env.S3_PREFIX_PROXIED;

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION;
const S3_BUCKET_ACCESSKEY = process.env.S3_BUCKET_ACCESSKEY;
const S3_BUCKET_SECRETKEY = process.env.S3_BUCKET_SECRETKEY;
const IMAGE_PROXY_VERSION = process.env.IMAGE_PROXY_VERSION || 1;
const WM_OPACITY = process.env.WM_OPACITY || 107;

const s3 = new aws.S3({
  s3BucketEndpoint: true,
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  accessKeyId: S3_BUCKET_ACCESSKEY,
  secretAccessKey: S3_BUCKET_SECRETKEY,
});

let wmbuff = null;
let wmInfo = null;
let chunks = [];
getImage(S3_PATH_WATERMARK)
  .createReadStream()
  .on("data", (chunk) => {
    chunks.push(chunk);
  })
  .on("end", () => {
    const buffer = Buffer.concat(chunks);
    sharp(buffer)
      .composite([
        {
          input: Buffer.from([255, 255, 255, Number(WM_OPACITY)]),
          raw: {
            width: 1,
            height: 1,
            channels: 4,
          },
          tile: true,
          blend: "dest-in",
        },
      ])
      .toBuffer({ resolveWithObject: true })
      .then(({ info, data: buff }) => {
        wmbuff = buff;
        wmInfo = info;
      });
  });

function getImage(urn) {
  return s3.getObject({
    Bucket: S3_BUCKET_NAME,
    Key: urn,
  });
}

function putImage(urn, imgbuff, config) {
  return new Promise((resolve) => {
    s3.upload(
      {
        Bucket: S3_BUCKET_NAME,
        Key: urn,
        Body: imgbuff,
        ...config,
      },
      (err, data) => {
        resolve(data);
      }
    );
  });
}

function getImageTag(urn, timeout = 1000) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      log("timeout get image tagging", urn);
      resolve({ TagSet: [] });
    }, timeout);

    s3.getObjectTagging(
      {
        Bucket: S3_BUCKET_NAME,
        Key: urn,
      },
      (err, result) => {
        console.info(err, result);
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      }
    );
  });
}

function getImageMetadata(urn) {
  return new Promise((resolve) => {
    s3.headObject(
      {
        Bucket: S3_BUCKET_NAME,
        Key: urn,
      },
      (err, result) => {
        resolve(result);
      }
    );
  });
}

function putImageTag(urn, tagSet = []) {
  return new Promise((resolve) => {
    s3.putObjectTagging(
      {
        Bucket: S3_BUCKET_NAME,
        Key: urn,
        Tagging: {
          TagSet: tagSet,
        },
      },
      (err, data) => {
        resolve(data);
      }
    );
  });
}

function applyWatermark(imgbuff, wmbuff) {
  return sharp(imgbuff)
    .metadata()
    .then((meta) => {
      const { width, height } = meta;
      let ratio = Math.min(
        1,
        width / (3 * wmInfo.width),
        height / (3 * wmInfo.height)
      );

      return sharp(wmbuff)
        .resize({
          width: Math.floor(ratio * wmInfo.width),
          height: Math.floor(ratio * wmInfo.height),
        })
        .toBuffer()
        .then((wmbuff) => {
          const pos = Math.floor(Math.random() * 4);
          return sharp(imgbuff)
            .composite([
              {
                input: wmbuff,
                blend: "over",
                gravity: "center",
              },
              {
                input: wmbuff,
                blend: "over",
                gravity: ["northeast", "northwest", "southeast", "southwest"][
                  pos
                ],
              },
            ])
            .toBuffer({ resolveWithObject: true });
        });
    });
}

function fromS3ObjectMetaToHeader(result) {
  const headers = {
    ETag: result.ETag,
    "Content-Type": result.ContentType,
    "Last-Modified": result.LastModified,
    "Content-Length": result.ContentLength,
  };
  if (result.Expires) {
    headers.Expires = result.Expires;
  }
  if (result.CacheControl) {
    headers["Cache-Control"] = result.CacheControl;
  }

  return headers;
}

function forwardFileNotImage(filePath, req, res) {
  return getImageMetadata(filePath).then((meta) => {
    if (meta === null) {
      res.writeHead(404, "not found!");
      res.end();
      return;
    }
    const headers = fromS3ObjectMetaToHeader(meta);
    if (
      headers.ETag === req.headers["if-none-match"] ||
      headers.ETag === req.headers["if-match"]
    ) {
      res.writeHead(304, "not modified");
      res.end();
    } else {
      getImage(filePath)
        .createReadStream()
        .pipe(res);
    }
  });
}

class FileNotFoundError extends Error {
  constructor(filePath) {
    super(`file not found ${filePath}`);
  }
}

function findCachedImage(imgPath) {
  return getImageTag(imgPath).then((tagging) => {
    if (tagging === null) {
      throw new FileNotFoundError(imgPath);
    } else {
      const imgProxyUrn = tagging.TagSet.find(
        (i) => i.Key === "image-proxy-urn"
      );
      const imgProxyVersion = tagging.TagSet.find(
        (i) => i.Key === "image-proxy-version"
      );
      let versionKey = imgProxyVersion ? imgProxyVersion.Value : 1;
      log('find cached image -> server version %s, cached version %s', IMAGE_PROXY_VERSION, versionKey);
      log('find cached image -> cached urn', imgProxyUrn);
      if (String(IMAGE_PROXY_VERSION) !== String(versionKey)) {
        return null;
      } else {
        return imgProxyUrn ? imgProxyUrn.Value : null;
      }
    }
  });
}

const server = http.createServer((req, res) => {
  const url = URL.parse(req.url);
  const imgPath = decodeURI(String(url.pathname).replace(/^\//i, "")); // assume imgPath same as s3 path

  if (!/\.(jpg|jpeg|png|gif)$/.test(url.pathname)) {
    forwardFileNotImage(imgPath, req, res);
    return;
  }

  findCachedImage(imgPath)
    .then((cachedImagePath) => {
      log('cachedImagePath', cachedImagePath);
      if (cachedImagePath) {
        getImageMetadata(cachedImagePath).then((result) => {
          const headers = fromS3ObjectMetaToHeader(result);
          if (
            req.headers["if-none-match"] === headers.ETag ||
            req.headers["if-match"] === headers.ETag
          ) {
            res.writeHead(304);
            res.end();
            return;
          }
          res.writeHead(200, headers);
          getImage(cachedImagePath)
            .createReadStream()
            .pipe(res);
        });
      } else {
        let chunks = [];
        log("read origin image", imgPath);
        getImage(imgPath)
          .createReadStream()
          .on("data", (chunk) => {
            chunks.push(chunk);
          })
          .on("end", () => {
            const buffer = Buffer.concat(chunks);
            const processedPath = [S3_PREFIX_PROXIED, imgPath].join("/");
            log("start watermarking");
            applyWatermark(buffer, wmbuff).then(({ data: buffer, info }) => {
              log("end watermarking");
              putImage(processedPath, buffer, {
                Tagging: `origin-urn=${encodeURIComponent(imgPath)}`,
                ContentType: `image/${info.format}`,
                ContentLength: info.size,
              }).then((result) => {
                putImageTag(imgPath, [
                  {
                    Key: "image-proxy-urn",
                    Value: processedPath,
                  },
                ]);
                res.writeHead(200, {
                  ETag: result.ETag,
                });
                res.write(buffer);
                res.end();
              });
            });
          });
      }
    })
    .catch((err) => {
      console.error(err);
      res.writeHead(404, "file not found!");
      res.end();
      return;
    });
});

server.listen(PORT, "0.0.0.0", () => {
  console.info("server started!");
});
