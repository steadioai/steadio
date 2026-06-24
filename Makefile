.PHONY: demo dev build test smoke-test clean help

## Run full demo: zero-config, seeds data, opens dashboard
demo:
	@./scripts/demo.sh

## Start all services (detached)
dev:
	docker compose up -d

## Build all packages
build:
	pnpm build

## Run unit tests
test:
	pnpm test

## Run smoke + load tests against the local stack (PROXY_URL=... to override)
smoke-test:
	@./scripts/smoke-test.sh

## Stop all containers and remove volumes (use after demo or dev)
clean:
	docker compose --profile demo down -v
	pnpm clean

## Show available targets
help:
	@grep -E '^## ' Makefile | sed 's/^## //'

.DEFAULT_GOAL := help
