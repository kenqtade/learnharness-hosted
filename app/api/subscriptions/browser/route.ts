import { withStore } from "@/src/server";
import { subscriptionBrowserResponse } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withStore(subscriptionBrowserResponse);
export const POST = withStore(subscriptionBrowserResponse);
