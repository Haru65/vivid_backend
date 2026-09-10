FROM node:18.19.1-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

ENV NODE_ENV=production

EXPOSE 6000

CMD ["npm","start"]
