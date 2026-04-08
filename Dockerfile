FROM node:20-slim

RUN apt-get update && apt-get install -y python3 python3-pip ffmpeg && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages --no-cache-dir yt-dlp

WORKDIR /app
COPY package*.json .
RUN npm install --production
COPY . .

EXPOSE 3001
CMD ["node", "index.js"]
