/**
 * Sample question bank (spec-04). Dev/demo data so every screen in the spec has something to
 * show and the e2e review flow has items to act on. Idempotent — keyed by the English stem.
 *
 * These are illustrative, NOT legally reviewed exam content: every item is seeded as DRAFT with
 * `createdBy: HUMAN`, so nothing here can be mistaken for approved material. Real content comes
 * from the AI pipeline (spec-06) and human review.
 *
 *   pnpm db:seed-items
 */
import { PrismaClient } from "@prisma/client";

(process as unknown as { loadEnvFile?: (path: string) => void }).loadEnvFile?.(".env");

const db = new PrismaClient();

interface Seed {
  topicSlug: string;
  difficulty: number;
  correct: string;
  en: { stem: string; options: [string, string, string, string?]; explanation: string };
  nb: { stem: string; options: [string, string, string, string?]; explanation: string };
  citation: { sourceCode: string; ref: string };
}

const SEEDS: Seed[] = [
  {
    topicSlug: "right-of-way",
    difficulty: 2,
    correct: "b",
    en: {
      stem: "You approach an intersection with no signs or markings. Who has right of way?",
      options: [
        "You, because you are going straight ahead",
        "Traffic coming from your right",
        "Traffic coming from your left",
        "Whoever reaches the intersection first",
      ],
      explanation:
        "With no signs or markings the right-hand rule applies: you must yield to traffic approaching from your right.",
    },
    nb: {
      stem: "Du nærmer deg et kryss uten skilt eller oppmerking. Hvem har forkjørsrett?",
      options: [
        "Du, fordi du kjører rett fram",
        "Trafikk som kommer fra høyre",
        "Trafikk som kommer fra venstre",
        "Den som kommer først til krysset",
      ],
      explanation:
        "Uten skilt eller oppmerking gjelder høyreregelen: du har vikeplikt for trafikk som kommer fra høyre.",
    },
    citation: { sourceCode: "trafikkreglene", ref: "§ 7" },
  },
  {
    topicSlug: "right-of-way",
    difficulty: 3,
    correct: "c",
    en: {
      stem: "You are turning left at an intersection. An oncoming car is going straight ahead. What must you do?",
      options: [
        "Turn first, since you signalled first",
        "Sound the horn and turn",
        "Yield to the oncoming car",
        "Turn if the oncoming car is more than 50 metres away",
      ],
      explanation:
        "A driver turning left must yield to oncoming traffic going straight ahead or turning right.",
    },
    nb: {
      stem: "Du skal svinge til venstre i et kryss. En møtende bil kjører rett fram. Hva må du gjøre?",
      options: [
        "Svinge først, siden du blinket først",
        "Bruke hornet og svinge",
        "Vike for den møtende bilen",
        "Svinge hvis den møtende bilen er mer enn 50 meter unna",
      ],
      explanation:
        "Den som svinger til venstre har vikeplikt for møtende trafikk som kjører rett fram eller svinger til høyre.",
    },
    citation: { sourceCode: "trafikkreglene", ref: "§ 7 nr. 3" },
  },
  {
    topicSlug: "speed-positioning",
    difficulty: 1,
    correct: "a",
    en: {
      stem: "What is the general speed limit in built-up areas unless signs say otherwise?",
      options: ["50 km/h", "60 km/h", "40 km/h", "70 km/h"],
      explanation:
        "In built-up areas the general limit is 50 km/h; outside them it is 80 km/h unless signposted differently.",
    },
    nb: {
      stem: "Hva er den generelle fartsgrensen i tettbygd strøk når ikke annet er skiltet?",
      options: ["50 km/t", "60 km/t", "40 km/t", "70 km/t"],
      explanation:
        "I tettbygd strøk er den generelle fartsgrensen 50 km/t; utenfor tettbygd strøk er den 80 km/t om ikke annet er skiltet.",
    },
    citation: { sourceCode: "trafikkreglene", ref: "§ 13 nr. 3" },
  },
  {
    topicSlug: "speed-positioning",
    difficulty: 3,
    correct: "b",
    en: {
      stem: "The road is wet and visibility is poor. The sign says 80 km/h. What speed should you drive?",
      options: [
        "80 km/h, the signposted limit",
        "A speed adapted to the conditions, below the limit",
        "Exactly 60 km/h",
        "Whatever the traffic around you is driving",
      ],
      explanation:
        "The signposted limit is a maximum, never a target. Speed must always be adapted to road, weather and visibility.",
    },
    nb: {
      stem: "Veien er våt og sikten er dårlig. Skiltet viser 80 km/t. Hvilken fart bør du holde?",
      options: [
        "80 km/t, som skiltet viser",
        "En fart tilpasset forholdene, under fartsgrensen",
        "Nøyaktig 60 km/t",
        "Samme fart som trafikken rundt deg",
      ],
      explanation:
        "Fartsgrensen er en øvre grense, ikke et mål. Farten skal alltid tilpasses vei-, vær- og siktforhold.",
    },
    citation: { sourceCode: "vegtrafikkloven", ref: "§ 3" },
  },
  {
    topicSlug: "the-vehicle",
    difficulty: 2,
    correct: "c",
    en: {
      stem: "What is the minimum legal tread depth on winter tyres during the winter season?",
      options: ["1.6 mm", "2 mm", "3 mm", "4 mm"],
      explanation:
        "Winter tyres must have at least 3 mm tread depth; summer tyres at least 1.6 mm.",
    },
    nb: {
      stem: "Hva er minste lovlige mønsterdybde på vinterdekk i vintersesongen?",
      options: ["1,6 mm", "2 mm", "3 mm", "4 mm"],
      explanation:
        "Vinterdekk må ha minst 3 mm mønsterdybde; sommerdekk minst 1,6 mm.",
    },
    citation: { sourceCode: "kjoretoyforskriften", ref: "§ 13-3" },
  },
  {
    topicSlug: "the-vehicle",
    difficulty: 2,
    correct: "a",
    en: {
      stem: "Your car pulls to one side when you brake hard. What is the most likely cause?",
      options: [
        "Uneven braking force between the wheels",
        "Low windscreen washer fluid",
        "A worn cabin filter",
        "Incorrect radio antenna position",
      ],
      explanation:
        "Pulling under braking points to uneven braking force — worn pads, a sticking caliper or uneven tyre grip. Have it checked before driving further.",
    },
    nb: {
      stem: "Bilen trekker til siden når du bremser hardt. Hva er mest sannsynlig årsak?",
      options: [
        "Ujevn bremsekraft mellom hjulene",
        "Lite spylervæske",
        "Slitt kupéfilter",
        "Feil antenneposisjon",
      ],
      explanation:
        "At bilen trekker under bremsing tyder på ujevn bremsekraft — slitte klosser, en kalipper som henger eller ujevnt dekkgrep. Få det kontrollert før du kjører videre.",
    },
    citation: { sourceCode: "kjoretoyforskriften", ref: "§ 8-1" },
  },
  {
    topicSlug: "traffic-participants",
    difficulty: 2,
    correct: "b",
    en: {
      stem: "A pedestrian is waiting at a marked crossing ahead of you. What must you do?",
      options: [
        "Continue if you can pass before they step out",
        "Give way and let the pedestrian cross",
        "Sound the horn to warn them",
        "Flash your headlights and continue",
      ],
      explanation:
        "At a marked pedestrian crossing you must give way to pedestrians who are crossing or about to cross.",
    },
    nb: {
      stem: "En fotgjenger står ved et gangfelt foran deg. Hva må du gjøre?",
      options: [
        "Kjøre videre hvis du rekker forbi før hun går ut",
        "Gi fotgjengeren fri veg og la henne krysse",
        "Bruke hornet for å varsle",
        "Blinke med lysene og kjøre videre",
      ],
      explanation:
        "Ved gangfelt har du vikeplikt for fotgjengere som går over eller er på vei ut i gangfeltet.",
    },
    citation: { sourceCode: "trafikkreglene", ref: "§ 9 nr. 2" },
  },
  {
    topicSlug: "traffic-participants",
    difficulty: 3,
    correct: "c",
    en: {
      stem: "You are overtaking a cyclist on a country road. How much space should you leave?",
      options: [
        "Enough to pass without touching",
        "About half a metre",
        "At least 1.5 metres",
        "Space does not matter if you drive slowly",
      ],
      explanation:
        "A cyclist can swerve for potholes or gusts. Leave at least 1.5 metres and wait for a safe moment rather than squeezing past.",
    },
    nb: {
      stem: "Du skal kjøre forbi en syklist på en landevei. Hvor stor avstand bør du holde?",
      options: [
        "Nok til å passere uten å berøre",
        "Omtrent en halv meter",
        "Minst 1,5 meter",
        "Avstanden betyr lite hvis du kjører sakte",
      ],
      explanation:
        "En syklist kan svinge unna hull eller vindkast. Hold minst 1,5 meter og vent på et trygt tidspunkt framfor å presse deg forbi.",
    },
    citation: { sourceCode: "trafikkreglene", ref: "§ 12" },
  },
  {
    topicSlug: "responsibility",
    difficulty: 1,
    correct: "a",
    en: {
      stem: "What is the general blood alcohol limit for driving in Norway?",
      options: ["0.2 ‰", "0.5 ‰", "0.8 ‰", "0.0 ‰"],
      explanation:
        "The limit is 0.2 ‰. Being under it is not the same as being fit to drive — impairment starts earlier.",
    },
    nb: {
      stem: "Hva er den generelle promillegrensen for å kjøre bil i Norge?",
      options: ["0,2 ‰", "0,5 ‰", "0,8 ‰", "0,0 ‰"],
      explanation:
        "Grensen er 0,2 ‰. Å være under grensen er ikke det samme som å være skikket til å kjøre — påvirkningen starter tidligere.",
    },
    citation: { sourceCode: "vegtrafikkloven", ref: "§ 22" },
  },
  {
    topicSlug: "responsibility",
    difficulty: 3,
    correct: "b",
    en: {
      stem: "You are involved in a collision with only material damage and the other driver is not present. What must you do?",
      options: [
        "Nothing, if the damage looks minor",
        "Leave your name and address, or notify the police",
        "Wait at the scene for at least two hours",
        "Report it to your insurer within 30 days and nothing else",
      ],
      explanation:
        "You must give your name and address to the affected party. If nobody is present, notify them or the police without undue delay.",
    },
    nb: {
      stem: "Du er involvert i et sammenstøt med kun materiell skade, og den andre føreren er ikke til stede. Hva må du gjøre?",
      options: [
        "Ingenting, hvis skaden ser liten ut",
        "Oppgi navn og adresse, eller varsle politiet",
        "Vente på stedet i minst to timer",
        "Melde fra til forsikringen innen 30 dager og ikke noe mer",
      ],
      explanation:
        "Du plikter å oppgi navn og adresse til den skadelidte. Er ingen til stede, må du varsle vedkommende eller politiet uten unødig opphold.",
    },
    citation: { sourceCode: "vegtrafikkloven", ref: "§ 12" },
  },
  {
    topicSlug: "laws-rules",
    difficulty: 2,
    correct: "c",
    en: {
      stem: "When must you use dipped headlights on a motor vehicle in Norway?",
      options: [
        "Only in darkness",
        "Only in tunnels and in darkness",
        "At all times while driving",
        "Only when visibility is below 100 metres",
      ],
      explanation:
        "Norway requires lights at all times: dipped headlights or daytime running lights whenever the vehicle is in motion.",
    },
    nb: {
      stem: "Når må du bruke nærlys på motorvogn i Norge?",
      options: [
        "Bare i mørke",
        "Bare i tunneler og i mørke",
        "Alltid under kjøring",
        "Bare når sikten er under 100 meter",
      ],
      explanation:
        "I Norge er det påbudt med lys hele døgnet: nærlys eller kjørelys så lenge kjøretøyet er i bevegelse.",
    },
    citation: { sourceCode: "kjoretoyforskriften", ref: "§ 28-1" },
  },
  {
    topicSlug: "signs-markings",
    difficulty: 2,
    correct: "a",
    en: {
      stem: "A solid yellow line runs along the centre of the road. What does it mean?",
      options: [
        "You must not cross it",
        "You may cross it when overtaking",
        "It marks a bus lane",
        "It marks the edge of the carriageway",
      ],
      explanation:
        "A solid centre line must not be crossed. Where it is broken, crossing is allowed when it is safe.",
    },
    nb: {
      stem: "En heltrukken gul linje går langs midten av vegen. Hva betyr den?",
      options: [
        "Du må ikke krysse den",
        "Du kan krysse den ved forbikjøring",
        "Den markerer et kollektivfelt",
        "Den markerer kjørebanens ytterkant",
      ],
      explanation:
        "Heltrukken midtlinje skal ikke krysses. Der linjen er stiplet, kan den krysses når det er trygt.",
    },
    citation: { sourceCode: "skiltforskriften", ref: "§ 22" },
  },
];

async function main(): Promise<void> {
  const topics = await db.topic.findMany({ select: { id: true, slug: true } });
  const topicBySlug = new Map(topics.map((topic) => [topic.slug, topic.id]));
  const classB = await db.licenseClass.findFirst({
    where: { code: "B" },
    select: { id: true },
  });

  let created = 0;
  let skipped = 0;

  for (const seed of SEEDS) {
    const topicId = topicBySlug.get(seed.topicSlug);
    if (!topicId) {
      console.warn(`skipping — unknown topic ${seed.topicSlug}`);
      continue;
    }

    const keys = ["a", "b", "c", "d"];
    const content = {
      en: {
        stem: seed.en.stem,
        options: seed.en.options
          .filter((text): text is string => Boolean(text))
          .map((text, index) => ({ key: keys[index], text })),
        explanation: seed.en.explanation,
      },
      nb: {
        stem: seed.nb.stem,
        options: seed.nb.options
          .filter((text): text is string => Boolean(text))
          .map((text, index) => ({ key: keys[index], text })),
        explanation: seed.nb.explanation,
      },
    };

    // Idempotent: the English stem identifies a seeded item.
    const existing = await db.masterItem.findFirst({
      where: { content: { path: ["en", "stem"], equals: seed.en.stem } },
      select: { id: true },
    });
    if (existing) {
      skipped++;
      continue;
    }

    await db.masterItem.create({
      data: {
        type: "TEXT",
        status: "DRAFT",
        topicId,
        licenseClassId: classB?.id ?? null,
        difficulty: seed.difficulty,
        content,
        correctOptionKey: seed.correct,
        legalCitations: [seed.citation],
        createdBy: "HUMAN",
      },
      select: { id: true },
    });
    created++;
  }

  console.log(`Sample questions: ${created} created, ${skipped} already present.`);
  console.log("All seeded as DRAFT — illustrative content, not reviewed exam material.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
