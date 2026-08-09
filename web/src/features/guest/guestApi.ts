// Guest mode's API surface, which is now just the local store's.
//
// Guest mode stopped being a separate system when lib/local/localApi arrived: a visitor
// with no account is running the offline client with sync switched off, not a second
// implementation of the app. This file stays behind as a re-export so that no page import
// had to change, and so `lib/api.ts` keeps ONE name for the thing it routes to.
//
// The refusal list and the error class live in ./guestErrors - localApi throws that class,
// so keeping it here would make this file import localApi and localApi import this file.
export { localApi as guestApi } from '../../lib/local/localApi';
export { GuestFeatureError, guestBlockedMessage } from './guestErrors';
