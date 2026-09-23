
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./

COPY . .

ENV PORT=8080 DATABASE_PATH=/data/app.sqlite3
EXPOSE 8080
# 启动前自动迁移与种子（数据卷已存在种子时自动跳过）
CMD ["npm", "start"]
