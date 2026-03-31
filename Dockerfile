FROM mcr.microsoft.com/playwright:v1.49.0-noble
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY naver-rank-checker.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "naver-rank-checker.js"]
