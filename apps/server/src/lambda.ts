import serverlessExpress from "@codegenie/serverless-express";
import { app } from "./index.ts";

/** AWS Lambda entry for API Gateway HTTP API. Same Express app as the local server; no routes are changed here. */
export const handler = serverlessExpress({ app });
