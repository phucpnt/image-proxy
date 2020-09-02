const http = require("http");
const sharp = require("sharp");
const URL = require("url");
const aws = require("aws-sdk");

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
          input: Buffer.from([255, 255, 255, 75]),
          raw: {
            width: 1,
            height: 1,
            channels: 4,
          },
          tile: true,
          blend: "dest-in",
        },
      ])
      .toBuffer()
      .then((buff) => {
        wmbuff = buff;
      });
  });

function getImage(urn) {
  return s3.getObject({
    Bucket: S3_BUCKET_NAME,
    Key: urn,
  });
}

function putImage(urn, imgbuff, meta) {
  return new Promise((resolve) => {
    s3.upload(
      {
        Bucket: S3_BUCKET_NAME,
        Key: urn,
        Body: imgbuff,
        Tagging: meta.Tagging,
        Metadata: meta.Metadata,
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
    .composite([
      {
        input: wmbuff,
        blend: "overlay",
        gravity: "center",
      },
    ])
    .toBuffer();
}

const server = http.createServer((req, res) => {
  const url = URL.parse(req.url);
  const imgPath = String(url.path).replace(/^\//i, ""); // assume imgPath same as s3 path

  getImageTag(imgPath).then((tagging) => {
    console.info("tagging", tagging);
    if (tagging === null) {
      console.error("file not found", imgPath);
      res.writeHead(404, "file not found!");
      res.end();
      return;
    }
    const imgProxyKV = tagging.TagSet.find((i) => i.Key === "image-proxy-urn");
    if (imgProxyKV) {
      console.info('proccessed image...', imgProxyKV);
      getImage(imgProxyKV.Value)
        .createReadStream()
        .pipe(res);
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
          applyWatermark(buffer, wmbuff).then((buffer) => {
            putImage(processedPath, buffer, {
              Tagging: `origin-urn=${encodeURIComponent(imgPath)}`,
            }).then(() => {
              putImageTag(imgPath, [
                {
                  Key: "image-proxy-urn",
                  Value: processedPath,
                },
              ]);
              res.write(buffer);
              res.end();
            });
          });
        });
    }
  });

  return;
  getImage(imgPath)
    .then((result) => {
      const { meta, buffer } = result;
      if (meta["x-amz-meta-imgproxy-urn"]) {
        processedImage = meta["x-amz-meta-imgproxy-urn"];
        getImage(processedImage).then((result) => {
          res.write(result.buffer);
          res.end();
        });
      } else {
        applyWatermark(buffer, wmbuff).then((buffer) => {
          res.write(buffer);
          res.end();
        });
      }
    })
    .catch((err) => {
      console.error("error with image path >", imgPath);
      console.error(err);
    });
});

server.listen(16101, "0.0.0.0", () => {
  console.info("server started!");
});
