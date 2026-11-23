import { defineSearchAttributeKey, SearchAttributeType } from '@temporalio/common';

// Registered on the dev server at startup (docker-compose.yml). They let an operator find lines in
// the Temporal UI, for example RowStatus="AP" AND AccountId="ACC-123456".
export const RowStatusAttribute = defineSearchAttributeKey('RowStatus', SearchAttributeType.KEYWORD);
export const AccountIdAttribute = defineSearchAttributeKey('AccountId', SearchAttributeType.KEYWORD);
