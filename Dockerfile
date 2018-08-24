FROM cheeaun/puppeteer:1.1.1
COPY . /app
RUN cd /app && yarn --production
EXPOSE 3000
WORKDIR /app
CMD yarn start
