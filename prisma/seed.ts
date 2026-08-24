/**
 * Seed (spec-02): license classes (from school config), bilingual temaliste topic
 * tree, one default exam blueprint for class B. Idempotent — safe to re-run.
 * Sign registry + KB sources are seeded in spec-05.
 */
import { PrismaClient } from "@prisma/client";
import { schoolConfig } from "../config/school.config";

const prisma = new PrismaClient();

type Bilingual = { en: string; nb: string };

const LICENSE_CLASS_NAMES: Record<string, Bilingual> = {
  B: { en: "Car (class B)", nb: "Personbil (klasse B)" },
};

interface TopicSeed {
  slug: string;
  name: Bilingual;
  children?: TopicSeed[];
}

// Official B-class temaliste main areas (matching the reference homepage categories),
// with starter subtopics — content team extends via the admin UI (spec-04/11).
const TOPIC_TREE: TopicSeed[] = [
  {
    slug: "traffic-participants",
    name: { en: "Drivers and other road users", nb: "Trafikantene" },
    children: [
      { slug: "vulnerable-road-users", name: { en: "Vulnerable road users", nb: "Myke trafikanter" } },
      { slug: "interaction-communication", name: { en: "Interaction and communication", nb: "Samhandling og kommunikasjon" } },
      { slug: "perception-reaction", name: { en: "Perception and reaction", nb: "Sansing og reaksjon" } },
    ],
  },
  {
    slug: "right-of-way",
    name: { en: "Right of way", nb: "Vikeplikt" },
    children: [
      { slug: "right-hand-rule", name: { en: "The right-hand rule", nb: "Høyreregelen" } },
      { slug: "priority-yield-signs", name: { en: "Priority and yield signs", nb: "Vikeplikt- og forkjørsregulering" } },
      { slug: "roundabouts", name: { en: "Roundabouts", nb: "Rundkjøringer" } },
      { slug: "emergency-public-transport", name: { en: "Emergency vehicles and buses", nb: "Utrykningskjøretøy og buss" } },
    ],
  },
  {
    slug: "the-vehicle",
    name: { en: "The vehicle", nb: "Kjøretøyet" },
    children: [
      { slug: "safety-inspection", name: { en: "Safety inspection", nb: "Sikkerhetskontroll" } },
      { slug: "tyres-brakes", name: { en: "Tyres and brakes", nb: "Dekk og bremser" } },
      { slug: "lights-visibility", name: { en: "Lights and visibility", nb: "Lys og sikt" } },
      { slug: "loading-towing", name: { en: "Loading and towing", nb: "Last og tilhenger" } },
    ],
  },
  {
    slug: "speed-positioning",
    name: { en: "Speed and lane positioning", nb: "Fart og plassering" },
    children: [
      { slug: "speed-limits", name: { en: "Speed limits", nb: "Fartsgrenser" } },
      { slug: "lane-choice", name: { en: "Lane choice and positioning", nb: "Feltvalg og plassering" } },
      { slug: "overtaking", name: { en: "Overtaking", nb: "Forbikjøring" } },
      { slug: "stopping-distance", name: { en: "Braking and stopping distance", nb: "Bremse- og stopplengde" } },
    ],
  },
  {
    slug: "signs-markings",
    name: { en: "Signs and road markings", nb: "Skilt og vegoppmerking" },
    children: [
      { slug: "warning-signs", name: { en: "Warning signs", nb: "Fareskilt" } },
      { slug: "prohibition-mandatory-signs", name: { en: "Prohibitory and mandatory signs", nb: "Forbuds- og påbudsskilt" } },
      { slug: "information-signs", name: { en: "Information signs", nb: "Opplysningsskilt" } },
      { slug: "road-markings", name: { en: "Road markings", nb: "Vegoppmerking" } },
    ],
  },
  {
    slug: "responsibility",
    name: { en: "Driver and owner responsibility", nb: "Fører- og eieransvar" },
    children: [
      { slug: "alcohol-drugs-health", name: { en: "Alcohol, drugs and health", nb: "Rus, helse og førerett" } },
      { slug: "documents-insurance", name: { en: "Documents and insurance", nb: "Dokumenter og forsikring" } },
      { slug: "accident-duties", name: { en: "Duties at accidents", nb: "Plikter ved trafikkuhell" } },
    ],
  },
  {
    slug: "laws-rules",
    name: { en: "Laws and regulations", nb: "Lover og regler" },
    children: [
      { slug: "road-traffic-act", name: { en: "The Road Traffic Act", nb: "Vegtrafikkloven" } },
      { slug: "traffic-rules", name: { en: "The traffic rules", nb: "Trafikkreglene" } },
      { slug: "penalties", name: { en: "Penalties and sanctions", nb: "Reaksjoner og sanksjoner" } },
    ],
  },
];

// Default class-B mock blueprint: counts over main topics, summing to questionCount (45)
const B_BLUEPRINT_DISTRIBUTION: Record<string, number> = {
  "traffic-participants": 6,
  "right-of-way": 8,
  "the-vehicle": 5,
  "speed-positioning": 7,
  "signs-markings": 9,
  "responsibility": 5,
  "laws-rules": 5,
};

async function main() {
  // 1. License classes from school config
  for (const [i, lc] of schoolConfig.licenseClassSeeds.entries()) {
    await prisma.licenseClass.upsert({
      where: { code: lc.code },
      create: {
        code: lc.code,
        name: LICENSE_CLASS_NAMES[lc.code] ?? { en: lc.code, nb: lc.code },
        questionCount: lc.questionCount,
        timeLimitMin: lc.timeLimitMin,
        passMark: lc.passMark,
        sortOrder: i,
      },
      update: {
        questionCount: lc.questionCount,
        timeLimitMin: lc.timeLimitMin,
        passMark: lc.passMark,
      },
    });
  }

  // 2. Topic tree (bilingual)
  for (const [i, main] of TOPIC_TREE.entries()) {
    const parent = await prisma.topic.upsert({
      where: { slug: main.slug },
      create: { slug: main.slug, name: main.name, sortOrder: i },
      update: { name: main.name, sortOrder: i },
    });
    for (const [j, child] of (main.children ?? []).entries()) {
      await prisma.topic.upsert({
        where: { slug: child.slug },
        create: { slug: child.slug, name: child.name, parentId: parent.id, sortOrder: j },
        update: { name: child.name, parentId: parent.id, sortOrder: j },
      });
    }
  }

  // 3. Default demo blueprint for B
  const classB = await prisma.licenseClass.findUniqueOrThrow({ where: { code: "B" } });
  const distributionSum = Object.values(B_BLUEPRINT_DISTRIBUTION).reduce((a, b) => a + b, 0);
  if (distributionSum !== classB.questionCount) {
    throw new Error(
      `Blueprint distribution sums to ${distributionSum}, expected ${classB.questionCount}`,
    );
  }
  const existing = await prisma.examBlueprint.findFirst({
    where: { licenseClassId: classB.id, isDefault: true },
    select: { id: true },
  });
  if (existing) {
    await prisma.examBlueprint.update({
      where: { id: existing.id },
      data: { topicDistribution: B_BLUEPRINT_DISTRIBUTION, imageRatio: 0.4 },
    });
  } else {
    await prisma.examBlueprint.create({
      data: {
        licenseClassId: classB.id,
        name: { en: "Standard mock exam (B)", nb: "Standard prøveeksamen (B)" },
        topicDistribution: B_BLUEPRINT_DISTRIBUTION,
        imageRatio: 0.4,
        isDefault: true,
      },
    });
  }

  const counts = {
    licenseClasses: await prisma.licenseClass.count(),
    topics: await prisma.topic.count(),
    blueprints: await prisma.examBlueprint.count(),
  };
  console.log("Seed complete:", counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
