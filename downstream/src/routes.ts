// The routes the product catalogue starts with (and goes back to on reset). Fulfilment loads a
// product's current route when a line starts; the console's Product routes page publishes new
// versions. Steps are listed in the order they're shown; steps in one stage run in parallel.

const providerOrder = {
  id: 'provider-order',
  name: 'Voice and data order to SNS/OSS',
  action: 'provider.submitVoiceAndData',
  accepted: true,
  undo: { action: 'provider.ceaseVoiceAndData', waitFor: 'CANCEL_ORDER_COMPLETED' },
};

const hub = (item: string) => ({
  id: 'hub',
  name: `Send ${item}`,
  action: 'logistics.dispatch',
  params: { item },
  waitFor: 'KIT_DELIVERED',
  undo: { action: 'logistics.recall' },
});

export const SEED_ROUTES = [
  {
    product: 'BROADBAND_SUPERFAST',
    version: 1,
    description: 'Provider order and hub delivery in parallel, then activation by the provider.',
    stages: [
      { name: 'Provision', steps: [providerOrder, hub('Sky Broadband Hub')] },
      { name: 'Activate', steps: [{ id: 'activation', name: 'Line activated by provider', waitFor: 'VOICE_AND_DATA_ORDER_COMPLETED' }] },
    ],
  },
  {
    product: 'BB_FIBRE_UNLIMITED_PRO',
    version: 1,
    description: 'Provider order, hub delivery and a fibre install visit in parallel, then data activation.',
    stages: [
      {
        name: 'Provision',
        steps: [
          providerOrder,
          hub('Sky Broadband Hub Pro'),
          {
            id: 'install',
            name: 'Fibre install visit',
            action: 'engineer.bookVisit',
            params: { job: 'Fibre to the premises install' },
            waitFor: 'ENGINEER_VISIT_COMPLETED',
            undo: { action: 'engineer.cancelVisit' },
          },
        ],
      },
      { name: 'Activate', steps: [{ id: 'activation', name: 'Data activated by provider', waitFor: 'DATA_ACTIVATED' }] },
    ],
  },
  {
    product: 'SKY_TV',
    version: 1,
    description: 'Sky Stream box sent to the customer; active once it is delivered.',
    stages: [
      {
        name: 'Deliver',
        steps: [
          {
            id: 'box',
            name: 'Send Sky Stream box',
            action: 'logistics.dispatch',
            params: { item: 'Sky Stream box' },
            accepted: true,
            waitFor: 'BOX_DELIVERED',
            undo: { action: 'logistics.recall' },
          },
        ],
      },
    ],
  },
  {
    product: 'NETFLIX',
    version: 1,
    description: 'Netflix account created through the partner; active once Netflix acknowledges it.',
    stages: [
      {
        name: 'Activate',
        steps: [
          {
            id: 'partner-account',
            name: 'Create Netflix account',
            action: 'partner.activate',
            params: { partner: 'Netflix' },
            accepted: true,
            waitFor: 'PARTNER_ACTIVATION_ACKNOWLEDGED',
            undo: { action: 'partner.deactivate' },
          },
        ],
      },
    ],
  },
];
