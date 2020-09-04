# image-proxy for watermark images in S3 or Digital Ocean Object storage
* Nodejs image proxy for watermarking images on S3. No database required.
* Optimized for speed.
* Leverage S3 tagging for Key Value storage.

** IMPORTANT **: this package has been tested on Digital Ocean Object storage but not tested yet on S3. 
Since the DO declare that Object Storage is fully compatable with S3, hence in general this image server
would be work correctly on AWS S3.


## How to use this repo
* There is a docker container hosted at: https://github.com/users/phucpnt/packages/container/image-proxy/30127
* To run the docker container, you need to define the following environment variables:
  ```ini
  S3_BUCKET_NAME="s3 bucket name"
  S3_PATH_WATERMARK="location when you store the watermark image. Support file format: .png, jpeg, .svg etc..."
  S3_PREFIX_PROXIED="the prefix location after image has been applying watermark. Eg. /_imgproxy/your/origin/image/path"
  S3_ENDPOINT="s3 endpoint"
  S3_REGION="s3 region id";
  S3_BUCKET_ACCESSKEY="s3 bucket accesskey";
  S3_BUCKET_SECRETKEY="s3 bucket secretkey";
  ```

