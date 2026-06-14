.DEFAULT_GOAL := help

.PHONY: help install install-hooks dev test test-coverage lint typecheck build clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

install-hooks: ## Install pre-commit hooks (requires pre-commit installed)
	pre-commit install
	pre-commit install --hook-type pre-push

dev: ## Start dev server
	npm run dev

test: ## Run tests
	npm run test

test-coverage: ## Run tests with coverage
	npm run test:coverage

lint: ## Run linter
	npm run lint

typecheck: ## Run type checking
	npm run typecheck

build: ## Production build
	npm run build

clean: ## Remove node_modules and build/cache artifacts (all workspaces)
	rm -rf node_modules **/node_modules **/dist **/.next **/.turbo **/coverage .vitest-cache .turbo