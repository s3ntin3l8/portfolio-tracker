.DEFAULT_GOAL := help

.PHONY: help install install-hooks web-env pytr-venv services services-down dev dev-web test test-coverage lint typecheck format build clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

install-hooks: ## Install pre-commit hooks (requires pre-commit installed)
	pre-commit install
	pre-commit install --hook-type pre-push

web-env: ## Link root .env into apps/web so Next.js (cwd=apps/web) can read it
	ln -sf ../../.env apps/web/.env.local

pytr-venv: ## Create local pytr venv for Trade Republic sync (then set PYTR_PYTHON_BIN in .env)
	python3 -m venv .venv-pytr
	.venv-pytr/bin/pip install --upgrade pip
	.venv-pytr/bin/pip install -r services/api/python/requirements.txt
	@echo "Add to .env:  PYTR_PYTHON_BIN=$(CURDIR)/.venv-pytr/bin/python"

services: ## Start local backing services (Postgres + MinIO)
	docker compose up -d postgres minio

services-down: ## Stop local backing services
	docker compose down

dev: ## Start all dev servers (API + web via Turbo)
	npm run dev

dev-web: ## Start only the web app dev server (mock data, no API needed)
	npm run dev --workspace @portfolio/web

test: ## Run tests
	npm run test

test-coverage: ## Run tests with coverage
	npm run test:coverage

lint: ## Run linter
	npm run lint

typecheck: ## Run type checking
	npm run typecheck

format: ## Format with Prettier
	npm run format

build: ## Production build
	npm run build

clean: ## Remove node_modules and build/cache artifacts (all workspaces)
	rm -rf node_modules **/node_modules **/dist **/.next **/.turbo **/coverage .vitest-cache .turbo
