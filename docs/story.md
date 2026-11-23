# The story

## The sentence

Fulfilment runs at the level of the customer's product portfolio: every order changes the portfolio, each product follows a route defined in configuration, and a second order can change, skip or undo the steps of a first one still in flight, without races, lost updates, or a customer billed for something that isn't provisioned.

## The use case

A customer orders broadband, Sky TV and Netflix in one order. Each product becomes a product line with its own route from the product catalogue: broadband sends a provider order and a hub in parallel, then waits for activation; TV waits for its box to be delivered; Netflix waits for the partner to acknowledge the account. These gates are external events that can take days.

Before the broadband line activates, the customer upgrades to Fibre Unlimited Pro (the Broadband PreActive Upgrade scenario). Depending on the bundle behaviour, fulfilment either:

- **REVERT:** undoes the old line's completed steps (cease at the provider by order reference, recall the hub): old row AP -> PAX -> CN. Then the upgrade is provisioned.
- **PROVIDE:** sends one combined migrate order. The old row gets a CROSSGRADE cease and stays AP.

Meanwhile the business changes the broadband route (the engineer now brings the hub). Lines already running keep the version they started on unless an operator moves them; new lines get the new version.

## What it answers

These are the questions the scenario and the design discussions raised, and where the demo answers each one.

| Question | The demo's answer |
|---|---|
| At what level are the Workflows? | One long-lived portfolio Workflow per customer receives every order. Each product line is a child Workflow that lives as long as the product is held. |
| Products take different routes through one process, with different entry points. Can routes live in configuration? | The lifecycle (gates, undo, billing, the row state model) is code. Which steps a product takes is a versioned route in the product catalogue, loaded once when the line starts. |
| What happens to in-flight orders when a route changes? | They stay pinned to their version. An operator can move one to the new version at its next gate, keeping shared progress, and choose whether to undo what the removed steps did. |
| A second order days later changes steps of the first. | The portfolio validates the new order against what the customer holds, then tells the affected line to revert, migrate or cease. |
| Several products in one order; cancelling part of an order. | Lines run independently in parallel; cancelling one undoes its steps and leaves the others running. |
| Apps need to see where a process is. | The console reads each Workflow's memo through List and Describe, live, without a Worker. |

## The problems

| Problem | Appears when | Resolved when | Proof |
|---|---|---|---|
| An upgrade races activation. Handled loosely, a line is cancelled after the provider activated it, or both lines end up live. | Send the activation event, then upgrade (or the other way round). | Each line handles its messages one at a time in arrival order. Activation first: the upgrade crossgrades the live line, which bills until the upgrade activates. Upgrade first: a late activation is "logged only". | The line's History; the Event History in the Temporal UI. |
| A downstream system fails halfway: the provider confirmed a cease but Portfolio is down, or a line activated but billing is down. | Set a system to Failing in the Downstream systems drawer, then act on a line. | Temporal retries with backoff; the line shows the attempt count and the 503. Set it back to Healthy and the line moves on. | The retry callout, the Worker log, the pending Activity in the Temporal UI. |
| Lines wait days at gates and must survive restarts, deploys and route changes. | `make crash-worker` while lines are waiting; publish a new route version. | The console keeps showing every line. `make start-worker` and lines carry on. Running lines keep their route version. | The Event History has no repeated steps; the line shows its route version. |

## Sources

- The scenario, state models and sequence come from the Broadband PreActive Upgrade Scenario document (v0.1, 17 Nov 2026).
- The portfolio level, configurable routes, gates and in-flight change come from the design discussions about it.
- No figures appear on screen.
