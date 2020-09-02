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
getImage(S3_PATH_WATERMARK).then((result) => {
  const { buffer } = result;

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
  return new Promise((resolve, reject) => {
    s3.getObject(
      {
        Bucket: S3_BUCKET_NAME,
        Key: urn,
      },
      (err, data) => {
        if (!err) {
          const meta = data.Metadata;
          resolve({ meta, buffer: data.Body });
        } else {
          reject(err);
        }
      }
    );
  });
}

function putImage(urn, imgbuff, meta) {
  return new Promise((resolve) => {
    s3.upload(
      {
        Bucket: S3_BUCKET_NAME,
        Key: urn,
        Body: imgbuff,
        Metadata: meta,
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
