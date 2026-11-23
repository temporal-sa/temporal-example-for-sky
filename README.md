# Broadband fulfilment at the portfolio level

A fulfilment console built on Temporal. Each customer's portfolio takes every order. Each product line follows a route from the product catalogue. A second order (an upgrade before activation, a cancellation of one product) changes the steps of lines still in flight, while downstream systems fail and recover around it.

What's in it:

- A **portfolio** [Workflow](https://docs.temporal.io/workflows) per customer, started and sent orders with [Update-With-Start](https://docs.temporal.io/develop/typescript/message-passing#update-with-start). Its Update validator refuses an order that conflicts with what the customer holds.
- A **product line** [Child Workflow](https://docs.temporal.io/develop/typescript/child-workflows) per product. It runs its route stage by stage, with parallel steps and gates that wait for external events ([Signals](https://docs.temporal.io/develop/typescript/message-passing#signals)). It undoes completed steps when cancelled, and bills only while active.
- **Routes as configuration**: versioned in a simulated product catalogue and edited on the console's Product routes page. A line loads its route once, so it stays on that version. A [Workflow Update](https://docs.temporal.io/develop/typescript/message-passing#updates) moves a running line to another version at its next gate, with or without compensation.
- The **PreActive Upgrade** scenario: REVERT (AP -> PAX -> CN) or PROVIDE (one migrate order), and the race with activation in both directions.
- [Activity retries](https://docs.temporal.io/encyclopedia/retry-policies) for seven simulated downstream systems, shown live in the console.
- A console that reads state from each Workflow's memo through Describe and List, so it keeps working while the Worker is down.

## How it works

```mermaid
sequenceDiagram
    participant UI as Fulfilment console
    participant PF as Portfolio Workflow
    participant OLD as Line: Superfast
    participant NEW as Line: Fibre Pro
    participant DS as Downstream systems
    UI->>PF: Update-With-Start placeOrder (Superfast, TV, Netflix)
    PF->>DS: registerPortfolioChanges
    PF->>OLD: start child (and one per other product)
    OLD->>DS: load route v1 from catalogue
    OLD->>DS: provider order + dispatch hub (in parallel), row RQ -> AP
    UI->>PF: placeOrder (upgrade OLD, REVERT)
    PF->>NEW: start child (held)
    PF->>OLD: Signal replaceLine
    OLD->>DS: row PAX, cease at provider, recall hub
    DS-->>OLD: CANCEL_ORDER_COMPLETED (console button)
    OLD->>DS: row CN
    OLD->>PF: Signal lineReleased
    PF->>NEW: Signal releaseLine
    NEW->>DS: provider order, hub, engineer visit (in parallel), row AP
    DS-->>NEW: gates pass, DATA_ACTIVATED (console buttons)
    NEW->>DS: row AC, start billing
```

With PROVIDE, the old line logs a CROSSGRADE cease (its row stays AP) and releases its provider order; the upgrade sends one `MIGRATE_DATA_MIGRATE_VOICE` order. If the old line had already activated, it keeps billing until the upgrade activates, then the portfolio ceases it.

| Part | Where | What it does |
|---|---|---|
| Workflows | `fulfilment/src/workflows.ts` | `portfolio` (orders, validation, coordination) and `productLine` (runs a route) |
| Routes and types | `fulfilment/src/domain.ts` | Route shape and its checks, row states, views |
| Activities | `fulfilment/src/activities.ts` | One per downstream action: catalogue, Portfolio, provider, logistics, engineering, partner, billing |
| Worker | `fulfilment/src/worker.ts` | Runs both, logging in logfmt |
| Console API | `fulfilment/src/api.ts` | One view endpoint and one endpoint per action |
| Console | `console/` | Customers, product lines with their routes drawn live, the Product routes editor, the Downstream systems drawer |
| Simulated systems | `downstream/` | The seven systems, each switchable to slow or failing; the seed routes |
| Tests | `fulfilment/src/workflows.test.ts` | Nine scenarios against the dev server |

## Run it

Prerequisites: Docker, Docker Compose and `make`.

```sh
make up
```

Then open the console at http://localhost:8080 and the Temporal UI at http://localhost:8233.

| Command | Does |
|---|---|
| `make up` | Builds the images and starts everything |
| `make test` | Typechecks and runs the Workflow tests in a container |
| `make crash-worker` / `make start-worker` | Kills the Worker, and brings it back |
| `make logs` | Follows the Worker and API logs |
| `make reset` | A fresh dev server and empty downstream systems |
| `make down` | Stops everything |

Presenting it, and the code behind each step: [RUNBOOK.md](RUNBOOK.md). The use case and what it answers: [docs/story.md](docs/story.md).

## Notes

- This is a private, customer-specific demo. It runs locally only, and isn't built for the demo catalog (the kit's catalog-ready baseline is waived: no per-user workspaces or hosted ingress).
- External events are buttons in the console rather than timers, so a presenter controls when each gate passes. Gate SLAs and timeouts are left out.
- Routes choose among actions fulfilment already has (an Activity each). Adding a new kind of action is a code change; changing which actions a product takes, in what order and with which gates, is not.
- The scenario document doesn't say what happens to the old row after a PROVIDE migration, or name a state for a line ceased after activation. The demo leaves the row AP with a logged CROSSGRADE cease, and uses CE for a ceased active line.
- The Workers aren't versioned. Changing Workflow code means resetting the sandbox, since running lines would replay against the new code.
