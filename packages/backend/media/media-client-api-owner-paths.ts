/**
 * 按 owner 的媒体库落在哪(媒体第二入口的一个方面,决策 D26)。
 *
 * 默认 owner(且宿主给了 store)读写 store 里那一本,其余 owner 各一本
 * `<dataRoot>/owners/<uid>/<wid>/media`。投递件(`media-client-api-delivery.ts`)不认识路径,
 * 由装配方把这只函数递进它的 `libraryPaths`。
 *
 * 2026-10-04 随 server runtime 拆分从 `http-server/http-server-runtime.ts` 原样搬来(决策 D219),
 * 代码一行没改。
 */
import { join } from "node:path";
import type { OnethingMediaLibraryPaths } from "./media-library-service.js";
import {
	getOnethingMediaFilesDir,
	getOnethingMediaImagesDir,
	getOnethingMediaIndexPath,
} from "@onething/backend/storage";
import { isDefaultServerRequestContext, tenantDirectory } from "@onething/backend/http-server/http-server-tenant-paths.js";
import type { RuntimeRequestContext } from "@onething/backend/http-server/http-server-runtime-facade.js";

export function serverMediaLibraryPaths(
	dataRoot: string,
	context: RuntimeRequestContext,
	desktopStorePath?: string,
): OnethingMediaLibraryPaths {
	if (desktopStorePath && isDefaultServerRequestContext(context)) {
		return {
			indexPath: getOnethingMediaIndexPath({ storePath: desktopStorePath }),
			imagesDir: getOnethingMediaImagesDir({ storePath: desktopStorePath }),
			filesDir: getOnethingMediaFilesDir({ storePath: desktopStorePath }),
		};
	}

	const root = join(
		tenantDirectory(join(dataRoot, "owners"), context.userId, context.workspaceId),
		"media",
	);
	return {
		indexPath: join(root, "index.json"),
		imagesDir: join(root, "images"),
		filesDir: join(root, "files"),
	};
}
