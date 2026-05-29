import { http, HttpResponse } from 'msw';

const HORIZON_BASE = 'https://horizon-testnet.stellar.org';

const mockAccount = {
  id: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  account_id: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  sequence: '1234567890',
  subentry_count: 0,
  balances: [
    { balance: '100.0000000', asset_type: 'native', buying_liabilities: '0.0000000', selling_liabilities: '0.0000000' },
  ],
  thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
  flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
  signers: [
    { public_key: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', weight: 1, type: 'ed25519_public_key' },
  ],
};

const mockTransactions = {
  _embedded: {
    records: [
      {
        id: 'tx1',
        hash: 'abc123',
        ledger: 1000,
        created_at: '2024-01-01T00:00:00Z',
        source_account: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        fee_charged: '100',
        operation_count: 1,
        successful: true,
      },
    ],
  },
};

const mockLedger = {
  id: 'ledger1',
  sequence: 50000000,
  closed_at: '2024-01-01T00:00:00Z',
  transaction_count: 42,
  operation_count: 100,
  base_fee_in_stroops: 100,
};

export const handlers = [
  // Account endpoint
  http.get(`${HORIZON_BASE}/accounts/:accountId`, ({ params }) => {
    return HttpResponse.json({ ...mockAccount, id: params.accountId, account_id: params.accountId });
  }),

  // Transactions for an account
  http.get(`${HORIZON_BASE}/accounts/:accountId/transactions`, () => {
    return HttpResponse.json(mockTransactions);
  }),

  // Latest ledger
  http.get(`${HORIZON_BASE}/ledgers/:sequence`, () => {
    return HttpResponse.json(mockLedger);
  }),

  // Ledger list
  http.get(`${HORIZON_BASE}/ledgers`, () => {
    return HttpResponse.json({
      _embedded: { records: [mockLedger] },
    });
  }),

  // Operations for an account
  http.get(`${HORIZON_BASE}/accounts/:accountId/operations`, () => {
    return HttpResponse.json({ _embedded: { records: [] } });
  }),
];
