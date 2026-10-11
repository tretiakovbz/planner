FROM oven/bun:1
WORKDIR /app
COPY index.tsx ./
CMD ["bun", "index.tsx"]
