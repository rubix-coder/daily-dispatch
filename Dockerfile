FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
COPY feeds.opml ./
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
