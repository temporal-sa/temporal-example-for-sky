# Every target wraps Compose, so the host needs only Docker, Docker Compose and make.
# `temporal` CLI calls pass --disable-config-file so a developer's default profile can't point
# the demo at a real Cloud namespace.
COMPOSE ?= docker compose
TEMPORAL ?= $(COMPOSE) exec temporal temporal --disable-config-file --address 127.0.0.1:7233

.PHONY: up down reset test logs crash-worker start-worker workflows

up: ## Build the images and start the whole stack
	$(COMPOSE) up --build --detach --wait
	@echo "Fulfilment console: http://localhost:8080"
	@echo "Temporal UI:        http://localhost:8233"

down: ## Stop everything and drop all state
	$(COMPOSE) down --volumes --remove-orphans

reset: ## Back to the starting state: a fresh dev server and empty downstream systems
	$(COMPOSE) down --volumes --remove-orphans
	$(MAKE) up

test: ## Typecheck and run the Workflow tests inside a container, against the dev server
	$(COMPOSE) up --detach --wait temporal
	$(COMPOSE) --profile test run --rm --build test

logs: ## Follow the Worker and API logs
	$(COMPOSE) logs --follow worker api

crash-worker: ## Kill the fulfilment Worker mid-flight (SIGKILL, no graceful shutdown)
	$(COMPOSE) kill -s SIGKILL worker

start-worker: ## Bring the Worker back; lines resume from where they were
	$(COMPOSE) up --detach worker

workflows: ## List running portfolio and product line Workflows on the dev server
	$(TEMPORAL) workflow list --query 'ExecutionStatus="Running"'
