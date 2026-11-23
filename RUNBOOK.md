# Runbook: Broadband fulfilment at the portfolio level

## What it shows

A customer's portfolio takes every order, and each product line runs a route from the product catalogue. Along the way:

1. A second order (an upgrade before activation, a partial cancellation) changes the steps of a line already in flight, and races its activation.
2. Routes change while lines are running: lines stay on their version, or move at their next gate.
3. A downstream system fails halfway, and lines wait days at gates across Worker restarts.

The full story is in [docs/story.md](docs/story.md).

## Before you start

This demo runs only on your laptop; there is no hosted copy.

1. Run `make up` at least once before the session so the images are built (the first build takes a few minutes).
2. Open the console at http://localhost:8080 and the Temporal UI at http://localhost:8233 in two tabs.
3. Have a terminal open in the repo for `make crash-worker` and `make start-worker`.
4. If the console has customers from a rehearsal, open **Downstream systems** and click **Reset sandbox**. This also puts every route back to v1.

A healthy start: the console says "Live · updated" with the current time, **Downstream systems** shows "All healthy", and there are no customers.

## The walkthrough

### 1. One order, three products

Click **New order**, keep Broadband Superfast, Sky TV and Netflix, and click **Place order (3 products)**. The console opens the customer with the broadband line selected. All three lines reach AP within a second or two, each waiting at a different gate.

Point at the route on the broadband line: the provider order and the hub ran in parallel in stage 1; activation is stage 2. The line is "Waiting for KIT_DELIVERED".

Say: "The order went to the customer's portfolio, which started one Workflow per product. Each product follows its own route. Nothing here is holding a thread while it waits for the hub to arrive."

Proof: **Open portfolio in Temporal UI**. The portfolio Workflow is Running, with three child Workflows.

### 2. Upgrade before activation (REVERT)

On the broadband line, click **Upgrade to Fibre Pro**, keep **REVERT**, and click **Place upgrade order**.

The console switches to the new Fibre Pro line, "Held until … is released". Click the old line in the table. It's at PAX: the hub is undone (a recall was booked), and the provider order is "Undoing", waiting for the provider to confirm. Click **Send CANCEL_ORDER_COMPLETED**. The old line goes to CN. Open the Fibre Pro line: it has moved to AP with three parallel steps. Send **KIT_DELIVERED**, **ENGINEER_VISIT_COMPLETED** and **DATA_ACTIVATED**, and it reaches AC with "Billing since …".

Say: "The upgrade is just another order on the portfolio. The portfolio checked it against what the customer holds, then told the old line to revert. The old line undid what it had done, step by step, and only then let the upgrade go to the provider. Billing never started for the old line."

Proof: open **Downstream systems**. Portfolio rows show the old row CN and the new row AC. The provider order is `CEASE_REQUESTED`, the hub `RECALL_BOOKED`, and there's one billing subscription.

Variation: choose **PROVIDE (migrate)** instead. The old line finishes as Migrated with its row still AP, and the provider order list shows `MIGRATE_DATA_MIGRATE_VOICE from SNS-…`.

### 3. The race: activation and upgrade arrive together

- **Activation first.** Place a new order. Send **KIT_DELIVERED** and **VOICE_AND_DATA_ORDER_COMPLETED**: the line is Active and billing. Upgrade it. The old line stays "Active and billing until … activates"; nothing is cancelled at the provider. Finish the upgrade's gates: the old line goes to CE and its billing stops.
- **Upgrade first.** Place a new order and upgrade it with REVERT. On the old line (now PAX), open **Send a different event** and click **VOICE_AND_DATA_ORDER_COMPLETED**. History shows "Logged only: VOICE_AND_DATA_ORDER_COMPLETED received in PAX: no transition, only logged".

Say: "Each line handles its messages one at a time, in the order they arrived. Whichever comes first, activation or upgrade, decides the path. No locks, no status column to compare-and-swap."

### 4. Cancel one product of an order

On the customer from beat 1, select the Netflix line and click **Cancel this line**, then **Place cancellation order**. Netflix goes AP -> PAX -> CN (the partner account is deactivated). Sky TV carries on: send **BOX_DELIVERED** and it's Active.

Then try **Add products** with Broadband Superfast selected. The portfolio refuses it: "the customer already has Broadband Fibre Unlimited Pro …; raise an upgrade on it instead". Nothing is written to the Workflow's history for a refused order.

### 5. Change a route while lines are running

Place an order for a new customer with just Broadband Superfast, and leave it waiting for its hub.

Open **Product routes** -> Broadband Superfast -> **Draft a new version from v1**. Describe it ("The engineer brings the hub"), **Remove** the Send Sky Broadband Hub step, and **Add step** in Provision: name "Engineer installs the hub", action **Book an engineer visit**, gate **ENGINEER_VISIT_COMPLETED**. Click **Add**, then **Publish v2**.

Go back to the customer's line. It's still on v1, still waiting for its hub. A new order now gets v2.

On the v1 line, the **Route version** card offers v2: "Adds Engineer installs the hub. Removes Send Sky Broadband Hub." Tick **Undo what the removed steps already did (compensate)** and click **Move to v2 at the next gate**. The provider order stays done, the hub is recalled ("From v1: Send Sky Broadband Hub, Undone"), and the line waits for the engineer.

Say: "The process is code: the gates, the undo, billing, the row state model. Which steps a product takes is configuration, versioned. A line reads its route once, so it's recorded in its history and a later change can't pull it out from under it. Moving a line is a deliberate operator action, with a choice about compensation."

Leave compensation unticked to show the other choice: the hub step is dropped and the kit stays where it is.

### 6. A downstream system fails mid-change

Open **Downstream systems** and set **Billing** to **Failing**. Take a line to activation (send its last gate event). The line reaches AC and shows a pink "Billing call failed. Temporal is retrying it (attempt N…)" callout with the 503. Set Billing back to **Healthy**: on the next retry it shows "Billing since …".

Say: "The line is activated and Portfolio says AC, but the customer isn't billed until billing confirms. Nothing gives up halfway and leaves the systems disagreeing."

Proof: `make logs` shows `level=WARN msg="activity attempt failed; Temporal will retry it"` with the 503. Set Portfolio to Failing during a cancellation for the same effect on the row moves. Use **Slow** to show calls taking three seconds.

### 7. The Worker crashes

With lines waiting, run `make crash-worker`. The console still shows every customer and line: it reads the memo through the Temporal service, not the Worker. Send a gate event; it's accepted, because Temporal stores the Signal. Run `make start-worker`: within about ten seconds (the Worker bundles its Workflow code on start) the line acts on it.

Proof: in the Temporal UI, the Event History has no repeated Activities.

## Show it in code

Line numbers are for the current working tree. Replace them with commit permalinks once the repo has its first commit on `main`.

### Every order goes through the customer's portfolio

**When to use it:** beat 1, 2 or 4, or when someone asks what level the Workflows are at.

**Where it is:** `fulfilment/src/workflows.ts:91` (validator) and `:136` (handler); the start is in `fulfilment/src/api.ts` (`executeUpdateWithStart`).

```ts
setHandler(placeOrderUpdate, (request): PortfolioView => {
  // assign line IDs, record the order, queue the work
  work.push({ kind: 'order', order, lines });
  return view;
}, { validator: validateOrder });
```

**What you need to understand:**

- Update-With-Start starts the portfolio if the customer is new and delivers the order either way, in one call. The order ID is the Update ID, so a retried request is the same order.
- The validator runs before the Update is written to history. A refused order leaves no trace, and the console shows the reason.
- The portfolio starts each line as a Child Workflow with `parentClosePolicy: 'ABANDON'` (`:226`), because a line is a product holding that outlives any one run of the portfolio, which [continues as new](https://docs.temporal.io/develop/typescript/continue-as-new) when its history grows (`:269`).
- Docs: [Message passing in TypeScript](https://docs.temporal.io/develop/typescript/message-passing), [Entity Workflows](https://docs.temporal.io/evaluate/use-cases-design-patterns#entity-workflows).

### Run a route from configuration

**When to use it:** beat 1 or 5.

**Where it is:** `fulfilment/src/workflows.ts:545` (load), `:472` (stages), `:446` (a step)

```ts
view.route = await fulfilment.loadRoute(product);
// ...
for (const stage of view.route!.stages) {
  await Promise.all(stage.steps.map(runStep));
  if (interrupted()) break;
}
```

**What you need to understand:** the route is an Activity result, so it's recorded in the line's Event History. On replay the line gets the same route back, which is what pins it to its version. Each step's action is an Activity; its gate is a `condition` on Signals received (`:461`). A route can only use actions the code knows (`routeProblems` in `fulfilment/src/domain.ts`, checked before publishing and again when loading).

### Move a running line to a new route version

**When to use it:** beat 5.

**Where it is:** `fulfilment/src/workflows.ts:388` (the Update) and `:514` (`adoptRoute`)

**What you need to understand:** the Update's validator refuses a line that isn't being provisioned. Its handler loads the version, so a missing one fails the Update. The main loop switches at its next gate: steps both versions share keep their state, new ones run, and removed ones are undone (compensate) or dropped. This is a business-level version of the route, separate from Temporal's [Worker Versioning](https://docs.temporal.io/worker-versioning), which is how the code itself would be rolled out.

### Signals in arrival order settle the race

**When to use it:** beat 3.

**Where it is:** `fulfilment/src/workflows.ts:355`

**What you need to understand:** a Workflow handles Signals one at a time. If activation arrives first, the line completes its route and the upgrade crossgrades the live service. If the upgrade arrives first, the activation isn't expected any more and is logged without a transition.

### Retry a failing downstream system until it recovers

**When to use it:** beat 6.

**Where it is:** `fulfilment/src/workflows.ts:53`

```ts
const fulfilment = proxyActivities<FulfilmentActivities>({
  startToCloseTimeout: '10 seconds',
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '10 seconds' },
});
```

**What you need to understand:** every Activity uses this policy: 1s, 2s, 4s, 8s, then every 10s, with no attempt limit, because giving up halfway would leave Portfolio, the provider and billing disagreeing. A 4xx is thrown as non-retryable in `fulfilment/src/activities.ts`. Each downstream call is safe to repeat: each system keys requests by line and step. Billing starts only after the row reaches AC (`:595`). Docs: [Retry policies](https://docs.temporal.io/encyclopedia/retry-policies).

### Show state without asking the Worker

**When to use it:** beat 7, or when someone asks how an app shows live status.

**Where it is:** `fulfilment/src/workflows.ts:307`, read in `fulfilment/src/api.ts` (`/api/console`)

**What you need to understand:** each Workflow writes its view to the memo as it changes. The API reads lines with List (filtered by the `AccountId` Search Attribute) and the selected line with Describe, including pending Activity retries. The Temporal service answers these without a Worker. A Query would need a running Worker and costs an Action per call on Temporal Cloud. `RowStatus` is a Search Attribute too, so an operator can find lines in the Temporal UI with `RowStatus="PAX"`.

### Where the demo machinery lives

The simulated systems, their Healthy/Slow/Failing switch and the seed routes are in `downstream/src/`. The Workflows and Activities don't know they're talking to a simulation; in a real system the Activities' URLs point at the real services, and callbacks arrive at an endpoint that sends the same Signal as the console's buttons (`fulfilment/src/api.ts`, `/api/lines/:lineId/events`).

## Reset and tear down

- Between runs: **Downstream systems** -> **Reset sandbox** deletes every portfolio and line execution, resets the routes to v1, and clears the simulated systems. Or run `make reset` for a fresh dev server.
- After the session: `make down`. Nothing runs on Temporal Cloud.

## When something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| "Can't reach the fulfilment API" in the console | The `api` container is down or still starting | `docker compose ps`; `make up` |
| A line says "Waiting for a Worker to load its route" | The Worker is stopped (perhaps after `make crash-worker`) | `make start-worker` |
| A line says Retrying and never moves on | A downstream system is still set to Failing | **Downstream systems** -> set it to Healthy |
| The portfolio refuses an order | Intended: it conflicts with what the customer holds (a second broadband line, a second upgrade of the same line) | Read the reason; upgrade or cancel the existing line instead |
| **Move to vN** is refused | The line is no longer being provisioned, or is being cancelled | Only lines still being provisioned can move |
| Lines fail after a code change | Running lines replay against the new Workflow code | **Reset sandbox** after changing Workflow code |

## Run it locally

Prerequisites: Docker, Docker Compose and `make`. Nothing else is installed on the host.

```sh
make up       # build and start: dev server, Worker, API + console, simulated systems
make test     # typecheck and run the Workflow tests against the dev server
make logs     # follow the Worker and API logs
make reset    # back to a clean state
make down     # stop everything
```

The variables are listed in `.env.example`; `docker-compose.yml` sets them all. The dev server is started with the `RowStatus` and `AccountId` Search Attributes registered.
