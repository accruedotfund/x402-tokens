FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY dist ./dist
COPY bin ./bin
COPY meta ./meta
ENV PORT=8787
EXPOSE 8787
CMD ["node", "bin/x402-tokens.mjs"]
