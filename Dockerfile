FROM node:12
LABEL MAINTAINER phucpnt<pn.truongphuc@gmail.com>

COPY . /opt/data/image-proxy

WORKDIR /opt/data/image-proxy
RUN yarn install --production

ENV NODE_ENV=production
ENV PORT=16101
EXPOSE 16101
ENTRYPOINT [ "yarn", "run", "start"]
