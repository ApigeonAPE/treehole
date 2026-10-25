FROM node:24.22.1-alpine

# Install Haraka and dependencies
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm install -g haraka@3.3.5

# Create app directory
WORKDIR /app

# Copy package.json and install project dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && \
    apk del .build-deps

# Config files are mounted as volumes at runtime
EXPOSE 25 587
# Haraka -c points to the parent directory that contains config/
# -c /app -> reads /app/config/smtp.ini and friends
CMD ["haraka", "-c", "/app"]
