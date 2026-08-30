import { prisma } from "@/lib/db";
import { library } from "@/lib/library/service";
import { CATEGORIES } from "@/lib/library/taxonomy";

/**
 * Starter prompts: two per category.
 *
 * Written to be worth keeping rather than to fill a grid. Each names a real
 * task somebody in that category actually does, and the variables are the
 * decisions that change the answer - not decoration. Two prompts in the same
 * category do different jobs, so neither is a rewording of the other.
 */

export interface SeedPrompt {
  category: string;
  title: string;
  description: string;
  template: string;
}

export const SEED_PROMPTS: SeedPrompt[] = [
  // --- STUDY -------------------------------------------------------------
  { category: "STUDY", title: "Explain a concept at my level",
    description: "Get an explanation pitched at what you already know, with a check for understanding.",
    template: "Explain {TOPIC} to someone at {LEVEL} level. Assume I already understand {PRIOR_KNOWLEDGE}. Use one concrete analogy, then give me two questions that would reveal whether I have actually understood it." },
  { category: "STUDY", title: "Turn notes into a revision sheet",
    description: "Condense messy notes into an active-recall sheet for an exam.",
    template: "Turn these notes into a one-page revision sheet for {SUBJECT}, aimed at {EXAM_NAME}.\n\nNotes:\n{NOTES}\n\nFormat as question-and-answer pairs for active recall, ordered from most to least likely to be examined. Flag anything in the notes that looks wrong or incomplete." },

  // --- WRITING -----------------------------------------------------------
  { category: "WRITING", title: "Edit for a specific reader",
    description: "Rewrite a draft for one audience, keeping your voice.",
    template: "Rewrite the following for {AUDIENCE}, in a {TONE} tone, at roughly {WORD_COUNT} words.\n\nDraft:\n{DRAFT}\n\nKeep my voice and my argument. Change structure and wording where it helps that reader. List the three biggest changes you made and why." },
  { category: "WRITING", title: "Critique before I publish",
    description: "A hard read of a draft against its actual goal.",
    template: "Critique this draft. Its purpose is {PURPOSE} and its reader is {AUDIENCE}.\n\n{DRAFT}\n\nTell me: what does not land, what is unclear, what is unsupported, and what I should cut. Be specific and quote the lines. Do not rewrite it." },

  // --- RESEARCH ----------------------------------------------------------
  { category: "RESEARCH", title: "Map a question before I start",
    description: "Break a research question into what you need to find out.",
    template: "I am researching {RESEARCH_QUESTION} in the context of {CONTEXT}.\n\nBreak this into the sub-questions I need to answer, in the order I should answer them. For each, say what kind of source would settle it and what would make an answer unreliable. Flag any sub-question where the evidence is likely to be contested." },
  { category: "RESEARCH", title: "Compare sources on a claim",
    description: "Set two accounts side by side and find the real disagreement.",
    template: "Two sources disagree about {CLAIM}.\n\nSource A:\n{SOURCE_A}\n\nSource B:\n{SOURCE_B}\n\nIdentify exactly where they diverge, whether the disagreement is about facts, definitions or interpretation, and what evidence would resolve it. Do not pick a winner unless the evidence clearly supports one." },

  // --- CODING ------------------------------------------------------------
  { category: "CODING", title: "Review this change",
    description: "A focused code review against the risk you care about.",
    template: "Review this {LANGUAGE} change. My main concern is {CONCERN}.\n\n{CODE}\n\nPoint out correctness bugs first, then anything that will hurt later. For each, say what breaks and how likely it is. Skip style unless it hides a bug." },
  { category: "CODING", title: "Debug from a symptom",
    description: "Work back from what you observed to plausible causes.",
    template: "I am seeing {SYMPTOM} in {COMPONENT}. Expected behaviour: {EXPECTED}.\n\nRelevant code or logs:\n{EVIDENCE}\n\nGive me the most likely causes in order of probability, and for each the single cheapest check that would confirm or rule it out. Do not guess at a fix before the cause is established." },

  // --- ANALYSIS ----------------------------------------------------------
  { category: "ANALYSIS", title: "Interrogate a dataset",
    description: "Decide what a dataset can and cannot answer before analysing it.",
    template: "I have a dataset of {DATA_DESCRIPTION} covering {TIME_PERIOD}. I want to answer: {QUESTION}\n\nTell me what this data can genuinely answer, what it cannot, and what confounders would make a naive reading wrong. Then give me the specific cuts or comparisons worth running." },
  { category: "ANALYSIS", title: "Explain a number that moved",
    description: "Structure an investigation into a metric change.",
    template: "{METRIC} moved from {BEFORE} to {AFTER} between {PERIOD}. Known context: {CONTEXT}\n\nList the candidate explanations, separating changes in the underlying thing from changes in how it is measured. For each, say what evidence would support or kill it, and which to check first." },

  // --- DESIGN ------------------------------------------------------------
  { category: "DESIGN", title: "Critique a screen against its job",
    description: "Design feedback anchored to what the user is trying to do.",
    template: "Critique this interface. The user is trying to {USER_GOAL} and the screen is {SCREEN_DESCRIPTION}.\n\nAssess it on: what the user sees first, whether the primary action is obvious, what is competing for attention, and where someone would get stuck. Prioritise the fixes by how much friction each removes." },
  { category: "DESIGN", title: "Write the microcopy",
    description: "Get wording for a specific interface moment.",
    template: "Write the copy for {UI_ELEMENT} in a {PRODUCT_TYPE}. The user has just {USER_CONTEXT} and needs to understand {KEY_MESSAGE}.\n\nGive me three options at different levels of directness. For each, say what it assumes about the user. Keep it short enough to read without effort." },

  // --- PRESENTATION ------------------------------------------------------
  { category: "PRESENTATION", title: "Structure a talk around one point",
    description: "Build a deck outline that argues a single thing.",
    template: "I am presenting to {AUDIENCE} for {DURATION} about {TOPIC}. The one thing they should leave believing is: {KEY_MESSAGE}\n\nGive me a slide-by-slide outline that builds to that. For each slide: its single point and what belongs on it. Tell me what to cut if I lose five minutes." },
  { category: "PRESENTATION", title: "Prepare for the hard questions",
    description: "Anticipate the objections before you are in the room.",
    template: "I am presenting {PROPOSAL} to {AUDIENCE}. Their likely concerns: {KNOWN_CONCERNS}\n\nWhat are the hardest questions they will ask? For each, give the honest answer, and say which ones I genuinely do not have a good answer to — those are the ones I need to prepare for or concede." },

  // --- CAREER ------------------------------------------------------------
  { category: "CAREER", title: "Rewrite my experience for a role",
    description: "Reframe what you have done against a specific job.",
    template: "Rewrite my experience for this role.\n\nRole: {ROLE_DESCRIPTION}\n\nMy experience:\n{EXPERIENCE}\n\nLead with what this employer will care about. Keep everything factually true — reframe emphasis, never invent. Tell me which requirements I genuinely do not meet." },
  { category: "CAREER", title: "Prepare a difficult conversation",
    description: "Think through a conversation you are dreading.",
    template: "I need to have a conversation with {PERSON_ROLE} about {SUBJECT}. My goal is {GOAL}. What makes this hard: {DIFFICULTY}\n\nHelp me prepare: how to open, what they are likely to say, and where I should hold firm versus where I should be flexible. Tell me if my goal seems unreasonable." },

  // --- BUSINESS ----------------------------------------------------------
  { category: "BUSINESS", title: "Pressure-test a decision",
    description: "Argue against a choice before you commit to it.",
    template: "We are considering {DECISION}. The reasoning is {RATIONALE}. Constraints: {CONSTRAINTS}\n\nMake the strongest case against this. What assumptions is it resting on, which are weakest, and what would we see early if it were going wrong? Then say whether you think it is still the right call." },
  { category: "BUSINESS", title: "Write the one-page proposal",
    description: "Turn an idea into something a decision-maker can act on.",
    template: "Write a one-page proposal for {INITIATIVE}, addressed to {DECISION_MAKER}.\n\nContext: {CONTEXT}\nWhat I am asking for: {ASK}\n\nCover the problem, the proposal, what it costs, what it risks, and what happens if we do nothing. Lead with the ask. No filler." },

  // --- MARKETING ---------------------------------------------------------
  { category: "MARKETING", title: "Position against the alternative",
    description: "Sharpen positioning against what customers do today.",
    template: "Position {PRODUCT} for {SEGMENT}. Today they solve this by {CURRENT_ALTERNATIVE}.\n\nWhat is the sharpest honest reason to switch? Give me the positioning statement, the two objections that will come up, and how to answer them without overclaiming." },
  { category: "MARKETING", title: "Campaign concepts from one insight",
    description: "Generate distinct concepts rather than variations on one.",
    template: "Give me three campaign concepts for {PRODUCT} aimed at {AUDIENCE} on {CHANNEL}. The insight to build on: {INSIGHT}\n\nMake them genuinely different in approach, not three versions of the same idea. For each: the concept, why it would work on this audience, and its biggest risk." },

  // --- FINANCE -----------------------------------------------------------
  { category: "FINANCE", title: "Sanity-check a set of numbers",
    description: "Find what is wrong or missing in a financial picture.",
    template: "Review these figures for {ENTITY} covering {PERIOD}.\n\n{FIGURES}\n\nWhat looks wrong, internally inconsistent, or too good? What is missing that I would need to judge this properly? State any assumption you had to make, and do not estimate a number you cannot derive from what is here." },
  { category: "FINANCE", title: "Model a decision's cost",
    description: "Work out what a choice actually costs over time.",
    template: "I am deciding whether to {DECISION}. Known costs: {KNOWN_COSTS}. Time horizon: {HORIZON}\n\nWalk through the total cost including the ones people forget. Show the arithmetic. Say which inputs the answer is most sensitive to, and what I should find out before committing." },

  // --- PRODUCTIVITY ------------------------------------------------------
  { category: "PRODUCTIVITY", title: "Plan a week that fits",
    description: "Turn a list of commitments into a realistic week.",
    template: "Plan my week. Fixed commitments: {FIXED_COMMITMENTS}. What I need to make progress on: {PRIORITIES}. Time I actually have: {AVAILABLE_TIME}\n\nGive me a realistic plan, not an aspirational one. If it does not all fit, say so and tell me what to drop." },
  { category: "PRODUCTIVITY", title: "Unstick a stalled task",
    description: "Work out why something is not moving.",
    template: "I have been avoiding {TASK} for {DURATION}. What I think is stopping me: {PERCEIVED_BLOCKER}\n\nHelp me work out what is actually blocking it — unclear next step, missing information, a decision I am avoiding, or something else. Then give me the smallest possible next action." },

  // --- COMMUNICATION -----------------------------------------------------
  { category: "COMMUNICATION", title: "Draft a message with a goal",
    description: "Write a message that achieves something specific.",
    template: "Draft a {MESSAGE_TYPE} to {RECIPIENT}. What I want to happen: {DESIRED_OUTCOME}. Relevant background: {CONTEXT}\n\nKeep it short enough to read on a phone. Make the ask explicit. Tell me if what I am asking for is unreasonable or unclear." },
  { category: "COMMUNICATION", title: "Deliver difficult news",
    description: "Say something hard clearly and decently.",
    template: "I need to tell {RECIPIENT} that {NEWS}. Context they will want: {CONTEXT}. What I can and cannot offer: {OPTIONS}\n\nDraft this. Be direct — do not bury the news or pad it with softening. Be humane about the impact. Do not promise anything I did not list." },

  // --- OPERATIONS --------------------------------------------------------
  { category: "OPERATIONS", title: "Write a runbook",
    description: "Document a process so someone else can do it.",
    template: "Write a runbook for {PROCESS}, to be followed by {AUDIENCE}.\n\nWhat I do now: {CURRENT_STEPS}\n\nMake each step unambiguous and checkable. Call out what commonly goes wrong at each one and how to tell. Note anything I have described that seems risky or manual enough to be worth automating." },
  { category: "OPERATIONS", title: "Post-incident review",
    description: "Structure a blameless review of something that broke.",
    template: "Help me review an incident. What happened: {INCIDENT}. Impact: {IMPACT}. Timeline as I understand it: {TIMELINE}\n\nSeparate what went wrong from who did what. Identify the contributing conditions, not just the trigger. Propose changes that would have prevented it, and be honest about which are worth the cost." },

  // --- STRATEGY ----------------------------------------------------------
  { category: "STRATEGY", title: "Choose between options",
    description: "Compare real options against what actually matters.",
    template: "Help me choose between:\n{OPTIONS}\n\nWhat I am optimising for: {OBJECTIVE}. Constraints: {CONSTRAINTS}. Time horizon: {HORIZON}\n\nCompare them on the criteria that actually decide this, not a generic list. Name the trade-off each option makes, and say which you would choose and why." },
  { category: "STRATEGY", title: "Find the assumptions underneath",
    description: "Surface what a plan quietly depends on.",
    template: "Our plan is {PLAN}, to achieve {GOAL} by {TIMEFRAME}.\n\nWhat must be true for this to work? List the assumptions, mark which are load-bearing, and rank them by how confident we should be. For the shakiest, tell me the cheapest way to test it before we commit." },

  // --- OTHER -------------------------------------------------------------
  { category: "OTHER", title: "Explain a decision made for me",
    description: "Understand something you have been handed.",
    template: "Explain this decision and its consequences for me: {DECISION}\n\nMy situation: {MY_SITUATION}. What I am unsure about: {UNCERTAINTY}\n\nTell me what it means in practice, what my options are, and what I should ask about. Flag anything that looks like it deserves a second opinion." },
  { category: "OTHER", title: "Summarise something long",
    description: "Get a summary shaped by what you need from it.",
    template: "Summarise the following. I need it because {PURPOSE}, and I care most about {FOCUS}.\n\n{CONTENT}\n\nLead with what matters for my purpose. Note anything important that I did not ask about, and anything the source leaves unclear." },
];

export interface SeedResult { created: number; skipped: number; categories: number }

/**
 * Installs the starter prompts for a user.
 *
 * Idempotent by title: a prompt the user already has - or has edited - is left
 * alone, so re-running this never overwrites somebody's work.
 */
export async function seedLibraryPrompts(ownerId: string): Promise<SeedResult> {
  let created = 0;
  let skipped = 0;

  for (const seed of SEED_PROMPTS) {
    const existing = await prisma.promptTemplate.findFirst({
      where: { ownerId, title: seed.title, deletedAt: null },
      select: { id: true },
    });
    if (existing) { skipped++; continue; }

    await library.create(ownerId, {
      title: seed.title,
      description: seed.description,
      category: seed.category,
      template: seed.template,
      // Variables are derived from the template by the existing parser, so
      // they cannot drift out of step with the text.
      variables: [],
    });
    created++;
  }

  return {
    created, skipped,
    categories: new Set(SEED_PROMPTS.map((s) => s.category)).size,
  };
}

/** Every category has exactly two, which the tests assert. */
export const SEEDS_PER_CATEGORY = 2;
export const SEEDED_CATEGORIES = CATEGORIES;
