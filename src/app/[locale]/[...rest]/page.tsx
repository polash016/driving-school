import { notFound } from "next/navigation";

// Unknown paths under a valid locale render the bilingual not-found page.
export default function CatchAllNotFound() {
  notFound();
}
