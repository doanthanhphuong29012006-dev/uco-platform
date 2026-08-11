# Eco-Oil UCO Platform

Backend-first MVP monorepo for a used cooking oil collection pilot.

## Stack

- Node.js + TypeScript + NestJS
- PostgreSQL 16 with PostGIS
- Redis
- Prisma
- pnpm + Turborepo

## Local development

```powershell
pnpm install
Copy-Item .env.example .env
docker compose up -d
pnpm prisma:migrate
pnpm generate
pnpm dev
```

The API listens on `http://localhost:3000` and the health endpoint is:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

PostgreSQL is exposed at `localhost:5433`; Redis is exposed at `localhost:6379`.
