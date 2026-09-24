import { pickBilingualText } from "@/lib/i18n-content";
import { db } from "@/server/db";
import { listPickableImages } from "@/server/services/images/library";

/** Everything both editor pages need: topics (indented tree), licence classes, images, sources. */
export async function editorData(locale: string) {
  const [topics, licenseClasses, images, sources] = await Promise.all([
    db.topic.findMany({
      where: { deletedAt: null, isActive: true },
      select: { id: true, name: true, parentId: true },
      orderBy: { sortOrder: "asc" },
    }),
    db.licenseClass.findMany({ where: { isEnabled: true }, select: { id: true, code: true }, orderBy: { code: "asc" } }),
    listPickableImages(db),
    db.kbSource.findMany({ where: { deletedAt: null }, select: { code: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  const options = topics
    .filter((topic) => !topic.parentId)
    .flatMap((root) => [
      { id: root.id, label: pickBilingualText(root.name, locale) },
      ...topics
        .filter((child) => child.parentId === root.id)
        .map((child) => ({ id: child.id, label: `— ${pickBilingualText(child.name, locale)}` })),
    ]);
  return { topics: options, licenseClasses, images, sources };
}
