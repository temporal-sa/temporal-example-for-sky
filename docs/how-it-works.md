# How it works

Five diagrams, from the whole system down to a single line's route. Each has its steps written out underneath. The code references point at `fulfilment/src/workflows.ts` unless they say otherwise.

## 1. The pieces, and who calls whom

```mermaid
%%{init: {"theme": "base", "flowchart": {"nodeSpacing": 40, "rankSpacing": 60, "padding": 18}, "themeVariables": {
  "fontSize": "15px",
  "primaryColor": "#141414",
  "primaryTextColor": "#f8fafc",
  "primaryBorderColor": "#444ce7",
  "lineColor": "#1ff1a5",
  "textColor": "#f8fafc",
  "clusterBkg": "#1a1830",
  "clusterBorder": "#465a78",
  "titleColor": "#cacbf9",
  "edgeLabelBackground": "#141414"
}}}%%
flowchart TB
  subgraph card[" "]
    direction TB
    subgraph env["YOUR ENVIRONMENT"]
      direction TB
      console["Fulfilment console + API"]
      subgraph worker["WORKER"]
        direction TB
        pf["portfolio<br/>one per customer"]
        pl["productLine<br/>one per product ordered"]
        cl["ceaseLine<br/>one per live line ceased"]
      end
      ds["Downstream systems<br/>catalogue · Portfolio · provider · logistics<br/>engineers · partner · billing"]
    end
    temporal[("Temporal")]
  end

  console -- "① order: Update-With-Start" --> pf
  pf -- "② starts a child per product" --> pl
  pl -- "③ Activities" --> ds
  ds -. "④ callbacks as Signals" .-> pl
  pl -- "⑤ progress Signals" --> pf
  pf -- "⑥ starts a child to cease" --> cl
  cl -- "Activities" --> ds
  console -- "⑦ List · Describe memos" --> temporal
  worker -- "polls for tasks" --> temporal

  classDef card fill:#141414,stroke:#141414,color:#141414
  classDef env fill:#141414,stroke:#1ff1a5,stroke-width:1px,stroke-dasharray:4 3,color:#1ff1a5
  classDef temporal fill:#141414,stroke:#444ce7,stroke-width:2px,color:#f8fafc
  classDef workflow fill:#141414,stroke:#b664ff,stroke-width:2px,color:#f8fafc
  classDef system fill:#141414,stroke:#4fd8ff,stroke-width:2px,color:#f8fafc
  classDef app fill:#141414,stroke:#7f86f1,stroke-width:1px,stroke-dasharray:4 3,color:#cacbf9
  class card card
  class env env
  class temporal temporal
  class pf,pl,cl workflow
  class ds system
  class console app
```

1. Every customer change is an order on the customer's portfolio, sent with Update-With-Start: it starts the portfolio for a new customer and delivers the order either way. The Update's validator refuses an order that conflicts with what the customer holds.
2. The portfolio starts one `productLine` Child Workflow per product on the order.
3. A line runs its route: each step's action is an Activity that calls a downstream system.
4. Downstream systems call back (in the demo, the console's buttons stand in for them). Each callback is a Signal to the line.
5. The line tells the portfolio about every change with a Signal, so the portfolio always knows the state of every line.
6. When a live line has to go (the customer ceased it, or its upgrade is live), the portfolio starts a `ceaseLine` Child Workflow.
7. The console reads state from the Workflows' memos with List and Describe, which the Temporal service answers without a Worker.

## 2. Three Workflows, three lifetimes

```mermaid
%%{init: {"theme": "base", "flowchart": {"nodeSpacing": 40, "rankSpacing": 60, "padding": 18}, "themeVariables": {
  "fontSize": "15px",
  "primaryColor": "#141414",
  "primaryTextColor": "#f8fafc",
  "primaryBorderColor": "#444ce7",
  "lineColor": "#1ff1a5",
  "textColor": "#f8fafc",
  "clusterBkg": "#1a1830",
  "clusterBorder": "#465a78",
  "titleColor": "#cacbf9",
  "edgeLabelBackground": "#141414"
}}}%%
flowchart TB
  subgraph card[" "]
    direction TB
    orders["portfolio<br/>starts a line per product"]
    begin["productLine<br/>BEGIN → RQ → AP"]
    ac["productLine completes<br/>AC, billing started"]
    cn["productLine completes<br/>PAX → CN, steps undone"]
    mig["productLine completes<br/>stays AP, order migrated"]
    decide["portfolio<br/>the customer ceased it,<br/>or its upgrade is live"]
    cease["ceaseLine<br/>stop billing → undo steps<br/>→ AC → CE"]
  end

  orders -- "①" --> begin
  begin -- "② activated" --> ac
  begin -- "② cancelled or REVERT" --> cn
  begin -- "② PROVIDE" --> mig
  ac -- "③ ACTIVE + undo plan" --> decide
  decide -- "④ starts" --> cease

  classDef card fill:#141414,stroke:#141414,color:#141414
  classDef portfolio fill:#141414,stroke:#444ce7,stroke-width:2px,color:#f8fafc
  classDef line fill:#141414,stroke:#b664ff,stroke-width:2px,color:#f8fafc
  classDef cease fill:#141414,stroke:#4fd8ff,stroke-width:2px,color:#f8fafc
  classDef done fill:#141414,stroke:#1ff1a5,stroke-width:2px,color:#f8fafc
  class card card
  class orders,decide portfolio
  class begin line
  class ac,cn,mig done
  class cease cease
```

The portfolio (blue) lives as long as the customer. A `productLine` (purple) runs for days or weeks. A `ceaseLine` (cyan) runs until the provider confirms the cease.

1. The portfolio starts a line for each product ordered.
2. The line runs until provisioning has an outcome (green): active (AC), cancelled (CN), or migrated to its replacement. Then its Workflow completes.
3. On activation the line hands the portfolio an undo plan: each completed step with the reference its system returned (the provider order, the consignment, the visit).
4. When the customer ceases the live line, or its upgrade goes live, the portfolio starts a `ceaseLine` with that plan.
5. The cease stops billing, undoes the steps unless the service migrated, moves the row to CE, and reports CEASED to the portfolio.

Why three lifetimes: only the portfolio lives for years, and it's a thin loop that [continues as new](https://docs.temporal.io/develop/typescript/continue-as-new). Every other Workflow runs for days or weeks. That keeps histories short and makes the code easy to roll out with [Worker Versioning](https://docs.temporal.io/worker-versioning): a line can stay pinned to the version it started on without keeping old Workers running for years.

## 3. How a line runs its route

```mermaid
%%{init: {"theme": "base", "flowchart": {"nodeSpacing": 40, "rankSpacing": 60, "padding": 18}, "themeVariables": {
  "fontSize": "15px",
  "primaryColor": "#141414",
  "primaryTextColor": "#f8fafc",
  "primaryBorderColor": "#444ce7",
  "lineColor": "#1ff1a5",
  "textColor": "#f8fafc",
  "clusterBkg": "#1a1830",
  "clusterBorder": "#465a78",
  "titleColor": "#cacbf9",
  "edgeLabelBackground": "#141414"
}}}%%
flowchart TB
  subgraph card[" "]
    direction TB
    catalogue[/"Product catalogue<br/>Superfast route v1"/]
    load["loadRoute Activity<br/>result kept in history"]
    subgraph s1["STAGE 1 · IN PARALLEL"]
      direction LR
      order["provider order<br/>Activity · row → AP"]
      hub["dispatch hub<br/>Activity"]
      kit{{"gate<br/>KIT_DELIVERED"}}
    end
    subgraph s2["STAGE 2 · ACTIVATE"]
      act{{"gate<br/>VOICE_AND_DATA_ORDER_COMPLETED"}}
    end
    live["AC · start billing<br/>Workflow completes"]
    op["Operator: changeRoute Update"]
    stopper["Portfolio: replaceLine or cancelLine Signal"]
    back["undo done steps<br/>last stage first → CN"]
  end

  catalogue -- "① once" --> load
  load -- "② stages in order" --> s1
  hub --> kit
  s1 -- "③ all steps done" --> s2
  s2 -- "④ gate passed" --> live
  op -. "⑤ adopt v2 at the next gate" .-> s1
  stopper -. "⑥ stop at the gate" .-> back

  classDef card fill:#141414,stroke:#141414,color:#141414
  classDef workflow fill:#141414,stroke:#b664ff,stroke-width:2px,color:#f8fafc
  classDef system fill:#141414,stroke:#4fd8ff,stroke-width:2px,color:#f8fafc
  classDef gate fill:#141414,stroke:#1ff1a5,stroke-width:2px,color:#f8fafc
  classDef resource fill:#141414,stroke:#7f86f1,stroke-width:1px,stroke-dasharray:4 3,color:#cacbf9
  class card card
  class load,live,back workflow
  class order,hub system
  class kit,act gate
  class catalogue,op,stopper resource
```

1. The line loads its route from the product catalogue once, with an Activity. The result is recorded in the Event History, so on replay the line gets the same route back: that's what pins it to its version.
2. Stages run in order; the steps inside a stage run in parallel (`runRoute`).
3. A step runs its action as an Activity, then waits at its gate: a `condition` on the Signals the line has received (`runStep`). An event that arrives early is kept for the step that needs it.
4. When every step is done, the line moves the row to AC, starts billing, and completes.
5. An operator can move a running line to another route version with the `changeRoute` Update. Its validator refuses a line that isn't provisioning; the switch happens at the next gate, keeping progress on shared steps and undoing (or leaving) removed ones (`adoptRoute`).
6. An upgrade or cancellation stops the line at its gate. It undoes what it did, last stage first, then the row goes to CN. With PROVIDE, it hands its provider order to the upgrade instead.

## 4. The race between activation and an upgrade

```mermaid
%%{init: {"theme": "base", "flowchart": {"nodeSpacing": 40, "rankSpacing": 60, "padding": 18}, "themeVariables": {
  "fontSize": "15px",
  "primaryColor": "#141414",
  "primaryTextColor": "#f8fafc",
  "primaryBorderColor": "#444ce7",
  "lineColor": "#1ff1a5",
  "textColor": "#f8fafc",
  "clusterBkg": "#1a1830",
  "clusterBorder": "#465a78",
  "titleColor": "#cacbf9",
  "edgeLabelBackground": "#141414"
}}}%%
flowchart TB
  subgraph card[" "]
    direction TB
    up["Upgrade order<br/>placeOrder Update"]
    pq{"Portfolio: is the old line<br/>still provisioning?"}
    sig["replaceLine Signal<br/>to the old line"]
    lq{"Old line: did activation<br/>arrive first?"}
    revert["Upgrade first<br/>REVERT: AP → PAX → CN<br/>PROVIDE: hand over the order"]
    released["lineReleased<br/>upgrade goes ahead"]
    ignore["Activation first<br/>line notes the upgrade,<br/>activates, completes"]
    cross["Portfolio sees ACTIVE<br/>upgrade crossgrades the live line"]
    golive["Upgrade activates"]
    cease["Portfolio starts ceaseLine<br/>old line: billing stops, AC → CE"]
  end

  up -- "①" --> pq
  pq -- "② yes" --> sig
  sig --> lq
  lq -- "③ no" --> revert
  revert --> released
  lq -- "③ yes" --> ignore
  ignore -- "④" --> cross
  pq -- "② no, it's live" --> cross
  cross --> golive
  golive -- "⑤" --> cease

  classDef card fill:#141414,stroke:#141414,color:#141414
  classDef workflow fill:#141414,stroke:#b664ff,stroke-width:2px,color:#f8fafc
  classDef decision fill:#141414,stroke:#444ce7,stroke-width:2px,color:#f8fafc
  classDef done fill:#141414,stroke:#1ff1a5,stroke-width:2px,color:#f8fafc
  class card card
  class up,sig,ignore,cross,golive workflow
  class pq,lq decision
  class revert,released,cease done
```

1. The upgrade is an order on the portfolio. Its validator has already refused it if the old line is being ceased or replaced.
2. If the portfolio knows the old line is live, it doesn't involve the line at all. Otherwise it Signals the old line.
3. A Workflow handles its messages one at a time, in arrival order. If the upgrade arrives first, the old line cancels (REVERT) or migrates (PROVIDE) and releases the customer's line, and a late activation is only logged. If activation arrived first, the line activates and completes.
4. The portfolio hears the line is ACTIVE and releases the upgrade to crossgrade the live service. The old line keeps billing.
5. When the upgrade activates, the portfolio starts a `ceaseLine` for the old line: billing stops, nothing is undone (the service migrated), and the row goes to CE.

Whichever way the race goes, one Workflow makes each decision, from state only it changes: the line decides whether it activated, and the portfolio decides what happens to a live line. There's no shared status to lock or compare-and-swap. The portfolio does this in `releaseIfDue` and `ceaseIfDue`.

## 5. What the console reads

```mermaid
%%{init: {"theme": "base", "flowchart": {"nodeSpacing": 40, "rankSpacing": 60, "padding": 18}, "themeVariables": {
  "fontSize": "15px",
  "primaryColor": "#141414",
  "primaryTextColor": "#f8fafc",
  "primaryBorderColor": "#444ce7",
  "lineColor": "#1ff1a5",
  "textColor": "#f8fafc",
  "clusterBkg": "#1a1830",
  "clusterBorder": "#465a78",
  "titleColor": "#cacbf9",
  "edgeLabelBackground": "#141414"
}}}%%
flowchart TB
  subgraph card[" "]
    direction TB
    browser["Console<br/>refreshes every couple of seconds"]
    api["API<br/>caches history by memo rev"]
    temporal[("Temporal")]
    worker["Worker"]
    memo[/"Memo: status, row, steps,<br/>what it waits for, rev"/]
    hist[/"history Query:<br/>the Workflow's timeline"/]
  end

  browser -- "① one request" --> api
  api -- "② List · Describe" --> temporal
  temporal -. "no Worker needed" .-> memo
  api -- "③ only when rev changed" --> temporal
  temporal -- "Query needs a Worker" --> worker
  worker -.-> hist

  classDef card fill:#141414,stroke:#141414,color:#141414
  classDef temporal fill:#141414,stroke:#444ce7,stroke-width:2px,color:#f8fafc
  classDef app fill:#141414,stroke:#7f86f1,stroke-width:1px,stroke-dasharray:4 3,color:#cacbf9
  classDef workflow fill:#141414,stroke:#b664ff,stroke-width:2px,color:#f8fafc
  classDef data fill:#141414,stroke:#4fd8ff,stroke-width:2px,color:#f8fafc
  class card card
  class temporal temporal
  class browser,api app
  class worker workflow
  class memo,hist data
```

1. The console makes one request per refresh, and the API makes the Temporal calls.
2. Everything the console needs to show a line moving comes from memos, read with List and Describe: status, row state, step states, the events a line waits for, billing, pending Activity retries. The Temporal service answers these without a Worker, so the console keeps updating while the Worker is down. The memo stays small. The route comes from the catalogue by version, and the history isn't in it, so a memo write doesn't copy the history into the Event History again.
3. The history (the timeline under each line) comes from the `history` Query. Each memo carries a `rev` that changes on every write, and the API sends the Query only when `rev` has moved on: one Query per change, not one per refresh. A Query needs a Worker, so while it's down the console shows the last history it got and says so.
