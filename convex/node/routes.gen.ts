"use node";

import type { RouteEntry } from "./bridge";

import * as route0 from "../../app/api/account/route";
import * as route1 from "../../app/api/activity/abort/route";
import * as route2 from "../../app/api/activity/route";
import * as route3 from "../../app/api/admin/config/route";
import * as route4 from "../../app/api/admin/invites/route";
import * as route5 from "../../app/api/admin/users/route";
import * as route6 from "../../app/api/auth/login/route";
import * as route7 from "../../app/api/auth/logout/route";
import * as route8 from "../../app/api/auth/me/route";
import * as route9 from "../../app/api/auth/signup/route";
import * as route10 from "../../app/api/capabilities/route";
import * as route11 from "../../app/api/chat/route";
import * as route12 from "../../app/api/chats/[id]/artifact-ui/route";
import * as route13 from "../../app/api/chats/[id]/dismiss/route";
import * as route14 from "../../app/api/chats/[id]/images/[snapshotId]/route";
import * as route15 from "../../app/api/chats/[id]/markdown/route";
import * as route16 from "../../app/api/chats/[id]/route";
import * as route17 from "../../app/api/chats/[id]/settings/route";
import * as route18 from "../../app/api/chats/[id]/side-chats/[threadId]/route";
import * as route19 from "../../app/api/chats/[id]/side-chats/[threadId]/stop/route";
import * as route20 from "../../app/api/chats/[id]/side-chats/route";
import * as route21 from "../../app/api/chats/[id]/steer/route";
import * as route22 from "../../app/api/chats/[id]/stream/route";
import * as route23 from "../../app/api/chats/route";
import * as route24 from "../../app/api/claude-code/route";
import * as route25 from "../../app/api/cron/update/route";
import * as route26 from "../../app/api/custom-provider/route";
import * as route27 from "../../app/api/eval/job/route";
import * as route28 from "../../app/api/events/route";
import * as route29 from "../../app/api/files/route";
import * as route30 from "../../app/api/graph/costs/route";
import * as route31 from "../../app/api/graph/coverage/extract/route";
import * as route32 from "../../app/api/graph/import/route";
import * as route33 from "../../app/api/graph/nodes/[id]/route";
import * as route34 from "../../app/api/graph/positions/route";
import * as route35 from "../../app/api/graph/render-settings/route";
import * as route36 from "../../app/api/graph/route";
import * as route37 from "../../app/api/graph/sources/route";
import * as route38 from "../../app/api/graph/status/route";
import * as route39 from "../../app/api/internal/run/route";
import * as route40 from "../../app/api/jobs/route";
import * as route41 from "../../app/api/keys/[id]/route";
import * as route42 from "../../app/api/keys/route";
import * as route43 from "../../app/api/models/route";
import * as route44 from "../../app/api/plugins/[id]/assets/[...file]/route";
import * as route45 from "../../app/api/plugins/[id]/call/route";
import * as route46 from "../../app/api/plugins/[id]/documents/markdown/route";
import * as route47 from "../../app/api/plugins/[id]/route";
import * as route48 from "../../app/api/plugins/route";
import * as route49 from "../../app/api/search/route";
import * as route50 from "../../app/api/settings/[section]/route";
import * as route51 from "../../app/api/settings/prompts/[...segment]/route";
import * as route52 from "../../app/api/settings/prompts/route";
import * as route53 from "../../app/api/settings/route";
import * as route54 from "../../app/api/stt/token/route";
import * as route55 from "../../app/api/subscriptions/browser/route";
import * as route56 from "../../app/api/subscriptions/route";
import * as route57 from "../../app/api/themes/[id]/route";
import * as route58 from "../../app/api/themes/route";
import * as route59 from "../../app/api/update/route";
import * as route60 from "../../app/api/version/route";

export const routes: readonly RouteEntry[] = [
	{
		pattern: "/api/account",
		methods: ["GET", "POST", "PATCH"],
		params: [],
		module: route0,
	},
	{
		pattern: "/api/activity/abort",
		methods: ["POST"],
		params: [],
		module: route1,
	},
	{
		pattern: "/api/activity",
		methods: ["GET"],
		params: [],
		module: route2,
	},
	{
		pattern: "/api/admin/config",
		methods: ["GET", "PUT"],
		params: [],
		module: route3,
	},
	{
		pattern: "/api/admin/invites",
		methods: ["GET", "POST", "DELETE"],
		params: [],
		module: route4,
	},
	{
		pattern: "/api/admin/users",
		methods: ["GET", "PATCH", "DELETE"],
		params: [],
		module: route5,
	},
	{
		pattern: "/api/auth/login",
		methods: ["POST"],
		params: [],
		module: route6,
	},
	{
		pattern: "/api/auth/logout",
		methods: ["POST"],
		params: [],
		module: route7,
	},
	{
		pattern: "/api/auth/me",
		methods: ["GET"],
		params: [],
		module: route8,
	},
	{
		pattern: "/api/auth/signup",
		methods: ["POST"],
		params: [],
		module: route9,
	},
	{
		pattern: "/api/capabilities",
		methods: ["GET"],
		params: [],
		module: route10,
	},
	{
		pattern: "/api/chat",
		methods: ["POST"],
		params: [],
		module: route11,
	},
	{
		pattern: "/api/chats/[id]/artifact-ui",
		methods: ["POST"],
		params: ["id"],
		module: route12,
	},
	{
		pattern: "/api/chats/[id]/dismiss",
		methods: ["POST"],
		params: ["id"],
		module: route13,
	},
	{
		pattern: "/api/chats/[id]/images/[snapshotId]",
		methods: ["GET"],
		params: ["id", "snapshotId"],
		module: route14,
	},
	{
		pattern: "/api/chats/[id]/markdown",
		methods: ["GET"],
		params: ["id"],
		module: route15,
	},
	{
		pattern: "/api/chats/[id]",
		methods: ["GET", "PUT", "DELETE"],
		params: ["id"],
		module: route16,
	},
	{
		pattern: "/api/chats/[id]/settings",
		methods: ["PUT"],
		params: ["id"],
		module: route17,
	},
	{
		pattern: "/api/chats/[id]/side-chats/[threadId]",
		methods: ["GET", "PATCH"],
		params: ["id", "threadId"],
		module: route18,
	},
	{
		pattern: "/api/chats/[id]/side-chats/[threadId]/stop",
		methods: ["POST"],
		params: ["id", "threadId"],
		module: route19,
	},
	{
		pattern: "/api/chats/[id]/side-chats",
		methods: ["GET", "POST"],
		params: ["id"],
		module: route20,
	},
	{
		pattern: "/api/chats/[id]/steer",
		methods: ["POST"],
		params: ["id"],
		module: route21,
	},
	{
		pattern: "/api/chats/[id]/stream",
		methods: ["GET"],
		params: ["id"],
		module: route22,
	},
	{
		pattern: "/api/chats",
		methods: ["GET", "POST"],
		params: [],
		module: route23,
	},
	{
		pattern: "/api/claude-code",
		methods: ["GET"],
		params: [],
		module: route24,
	},
	{
		pattern: "/api/cron/update",
		methods: ["GET"],
		params: [],
		module: route25,
	},
	{
		pattern: "/api/custom-provider",
		methods: ["GET", "POST", "PATCH", "DELETE"],
		params: [],
		module: route26,
	},
	{
		pattern: "/api/eval/job",
		methods: ["POST"],
		params: [],
		module: route27,
	},
	{
		pattern: "/api/events",
		methods: ["GET"],
		params: [],
		module: route28,
	},
	{
		pattern: "/api/files",
		methods: ["GET", "POST", "DELETE"],
		params: [],
		module: route29,
	},
	{
		pattern: "/api/graph/costs",
		methods: ["GET"],
		params: [],
		module: route30,
	},
	{
		pattern: "/api/graph/coverage/extract",
		methods: ["POST"],
		params: [],
		module: route31,
	},
	{
		pattern: "/api/graph/import",
		methods: ["POST"],
		params: [],
		module: route32,
	},
	{
		pattern: "/api/graph/nodes/[id]",
		methods: ["DELETE"],
		params: ["id"],
		module: route33,
	},
	{
		pattern: "/api/graph/positions",
		methods: ["PUT"],
		params: [],
		module: route34,
	},
	{
		pattern: "/api/graph/render-settings",
		methods: ["GET", "PUT"],
		params: [],
		module: route35,
	},
	{
		pattern: "/api/graph",
		methods: ["GET"],
		params: [],
		module: route36,
	},
	{
		pattern: "/api/graph/sources",
		methods: ["GET", "POST", "DELETE"],
		params: [],
		module: route37,
	},
	{
		pattern: "/api/graph/status",
		methods: ["GET"],
		params: [],
		module: route38,
	},
	{
		pattern: "/api/internal/run",
		methods: ["POST"],
		params: [],
		module: route39,
	},
	{
		pattern: "/api/jobs",
		methods: ["GET"],
		params: [],
		module: route40,
	},
	{
		pattern: "/api/keys/[id]",
		methods: ["PUT", "DELETE"],
		params: ["id"],
		module: route41,
	},
	{
		pattern: "/api/keys",
		methods: ["GET"],
		params: [],
		module: route42,
	},
	{
		pattern: "/api/models",
		methods: ["GET"],
		params: [],
		module: route43,
	},
	{
		pattern: "/api/plugins/[id]/assets/[...file]",
		methods: ["GET"],
		params: ["id", "file"],
		module: route44,
	},
	{
		pattern: "/api/plugins/[id]/call",
		methods: ["POST"],
		params: ["id"],
		module: route45,
	},
	{
		pattern: "/api/plugins/[id]/documents/markdown",
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		params: ["id"],
		module: route46,
	},
	{
		pattern: "/api/plugins/[id]",
		methods: ["PUT"],
		params: ["id"],
		module: route47,
	},
	{
		pattern: "/api/plugins",
		methods: ["GET", "POST"],
		params: [],
		module: route48,
	},
	{
		pattern: "/api/search",
		methods: ["GET"],
		params: [],
		module: route49,
	},
	{
		pattern: "/api/settings/[section]",
		methods: ["PUT"],
		params: ["section"],
		module: route50,
	},
	{
		pattern: "/api/settings/prompts/[...segment]",
		methods: ["PUT", "DELETE"],
		params: ["segment"],
		module: route51,
	},
	{
		pattern: "/api/settings/prompts",
		methods: ["GET"],
		params: [],
		module: route52,
	},
	{
		pattern: "/api/settings",
		methods: ["GET"],
		params: [],
		module: route53,
	},
	{
		pattern: "/api/stt/token",
		methods: ["GET"],
		params: [],
		module: route54,
	},
	{
		pattern: "/api/subscriptions/browser",
		methods: ["GET", "POST"],
		params: [],
		module: route55,
	},
	{
		pattern: "/api/subscriptions",
		methods: ["GET", "POST"],
		params: [],
		module: route56,
	},
	{
		pattern: "/api/themes/[id]",
		methods: ["DELETE"],
		params: ["id"],
		module: route57,
	},
	{
		pattern: "/api/themes",
		methods: ["GET", "POST"],
		params: [],
		module: route58,
	},
	{
		pattern: "/api/update",
		methods: ["GET", "POST"],
		params: [],
		module: route59,
	},
	{
		pattern: "/api/version",
		methods: ["GET"],
		params: [],
		module: route60,
	},
];
