# task-secretary
A personal task management web application with a rule-based digital secretary, daily briefings, reminders, and a SaaS-ready architecture.

## Live demo

The application is deployed on Railway with PostgreSQL: https://task-secretary-production.up.railway.app
Public sign-up is disabled; accounts are created by an administrator.

## Local development

1. Copy `.env.example` to `.env` and fill in the values (PostgreSQL must be running).
2. Run `npm install`.
3. Run `npm run db:migrate` to create the local database tables.
4. Run `npm run dev` and open http://localhost:3001.
5. Run `npm run user:create` to create your first account (sign-up is disabled).
