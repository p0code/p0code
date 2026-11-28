/*
 * MIT License
 * Copyright (c) 2026 p0code
 * Ported from https://github.com/p0code/deploy-cloudflare (v0.3.0)
 */
import {
  ALL_DEPLOY_PROVIDER_OPERATIONS,
  type DeployProviderOperation,
  type DeploySourceKind,
  type DeployTargetKind,
} from "@t3tools/contracts";
import {
  checkDeployProvider,
  type DeployProviderDescriptor,
  type StartedDeployProvider,
} from "@t3tools/plugin-api";
import type * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Path from "effect/Path";

import { type CloudflareProviderOptions, makeCloudflareProvider } from "./service.ts";

export const CLOUDFLARE_PROVIDER_INFO = {
  id: "cloudflare",
  label: "Cloudflare",
  icon: "cloud",
  version: "0.3.0",
  description:
    "Deploy Cloudflare Pages and Workers from p0code using Wrangler or a Cloudflare API token.",
  supportedOperations: ALL_DEPLOY_PROVIDER_OPERATIONS as ReadonlyArray<DeployProviderOperation>,
  supportedTargetKinds: ["pages", "worker"] as ReadonlyArray<DeployTargetKind>,
  supportedSourceKinds: ["git", "local-build"] as ReadonlyArray<DeploySourceKind>,
} as const;

const CLOUDFLARE_PROVIDER_DESCRIPTOR: DeployProviderDescriptor = {
  id: CLOUDFLARE_PROVIDER_INFO.id,
  label: CLOUDFLARE_PROVIDER_INFO.label,
  icon: CLOUDFLARE_PROVIDER_INFO.icon,
};

export type CreateCloudflareDeployProviderOptions = CloudflareProviderOptions;

/**
 * Creates a schema-checked built-in Cloudflare deploy provider (Pages and Workers) backed by the
 * host's credential storage and Effect platform services.
 */
export const createCloudflareDeployProvider = Effect.fn("createCloudflareDeployProvider")(
  function* (
    options: CreateCloudflareDeployProviderOptions,
  ): Effect.fn.Return<
    StartedDeployProvider,
    never,
    HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Digest.Digest
  > {
    const provider = yield* makeCloudflareProvider(options);
    return checkDeployProvider(CLOUDFLARE_PROVIDER_DESCRIPTOR, provider);
  },
);
