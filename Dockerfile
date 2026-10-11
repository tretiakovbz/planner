FROM oven/bun:1
WORKDIR /app
COPY index.tsx avatar.jpg ./
CMD ["bun", "index.tsx"]
