.PHONY: demo dev build test clean help

## Run full demo: start services, seed data, print dashboard URL
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

## Stop and remove all containers and volumes
clean:
	docker compose down -v
	pnpm clean

## Show available targets
help:
	@grep -E '^## ' Makefile | sed 's/^## //'

.DEFAULT_GOAL := help
