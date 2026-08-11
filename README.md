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
pnpm generate
pnpm dev
```

The API listens on `http://localhost:3000` and the health endpoint is:

```powershell
Invoke-RestMethod http://localhost:3000/health
```

Database migrations and seed data are introduced in the next implementation step.
