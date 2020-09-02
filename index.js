const http = require("http");
const sharp = require("sharp");
const URL = require("url");
const aws = require("aws-sdk");
const log = require("debug")("image-proxy");

const S3_PATH_WATERMARK = process.env.S3_PATH_WATERMARK;
const S3_PREFIX_ORIGIN = process.env.S3_PREFIX_ORIGIN;
const S3_PREFIX_PROXIED = process.env.S3_PREFIX_PROXIED;

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION;
const S3_BUCKET_ACCESSKEY = process.env.S3_BUCKET_ACCESSKEY;
const S3_BUCKET_SECRETKEY = process.env.S3_BUCKET_SECRETKEY;

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
          input: Buffer.from([255, 255, 255, 220]),
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

function getImageTag(urn) {
  return new Promise((resolve) => {
    s3.getObjectTagging(
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
                blend: "overlay",
                gravity: "center",
              },
              {
                input: wmbuff,
                blend: "overlay",
                gravity: ["northeast", "northwest", "southeast", "southwest"][
                  pos
                ],
              },
            ])
            .toBuffer({ resolveWithObject: true });
        });
    });
}

const server = http.createServer((req, res) => {
  const url = URL.parse(req.url);
  const imgPath = String(url.path).replace(/^\//i, ""); // assume imgPath same as s3 path

  getImageTag(imgPath).then((tagging) => {
    if (tagging === null) {
      console.error("file not found", imgPath);
      res.writeHead(404, "file not found!");
      res.end();
      return;
    }

    const imgProxyKV = tagging.TagSet.find((i) => i.Key === "image-proxy-urn");
    if (imgProxyKV) {
      getImageMetadata(imgProxyKV.Value).then((result) => {
        if(req.headers["if-none-match"] === result.ETag || req.headers['if-match'] === result.ETag){
          res.writeHead(304);
          res.end();
          return;
        }
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
        res.writeHead(200, headers);
        getImage(imgProxyKV.Value)
          .createReadStream()
          .pipe(res);
      });
    } else {
      let chunks = [];
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
              })
              res.write(buffer);
              res.end();
            });
          });
        });
    }
  });
});

server.listen(16101, "0.0.0.0", () => {
  console.info("server started!");
});
