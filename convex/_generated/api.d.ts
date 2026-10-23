/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountAccess from "../accountAccess.js";
import type * as accountDeletion from "../accountDeletion.js";
import type * as countStocks from "../countStocks.js";
import type * as fileCleanup from "../fileCleanup.js";
import type * as focusedLabels from "../focusedLabels.js";
import type * as http from "../http.js";
import type * as lib_desktopMcp from "../lib/desktopMcp.js";
import type * as lifeWorldFields from "../lifeWorldFields.js";
import type * as mcpTasks from "../mcpTasks.js";
import type * as migrations from "../migrations.js";
import type * as partners from "../partners.js";
import type * as notifications from "../notifications.js";
import type * as pushNotifications from "../pushNotifications.js";
import type * as notificationFields from "../notificationFields.js";
import type * as sync from "../sync.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountAccess: typeof accountAccess;
  accountDeletion: typeof accountDeletion;
  countStocks: typeof countStocks;
  fileCleanup: typeof fileCleanup;
  focusedLabels: typeof focusedLabels;
  http: typeof http;
  "lib/desktopMcp": typeof lib_desktopMcp;
  lifeWorldFields: typeof lifeWorldFields;
  mcpTasks: typeof mcpTasks;
  migrations: typeof migrations;
  partners: typeof partners;
  notifications: typeof notifications;
  pushNotifications: typeof pushNotifications;
  notificationFields: typeof notificationFields;
  sync: typeof sync;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
