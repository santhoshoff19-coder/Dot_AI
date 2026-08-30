/**
 * Library taxonomy: roles, the specializations each role actually has, the
 * experience levels, and the prompt categories.
 *
 * This is the single source. The UI imports it, the service ranks against it
 * and the API validates against it - duplicating it in a component is how the
 * old build ended up offering "SDE" and "UI/UX" to a Biology student.
 */

export const ROLES = [
  "Student", "Teacher", "Employee", "Researcher", "Freelancer", "Entrepreneur",
] as const;

export type Role = (typeof ROLES)[number];

/** Specializations are per role. There is no generic shared list. */
export const SPECIALIZATIONS: Record<Role, string[]> = {
  Student: [
    "Engineering", "Computer Science", "Data Science", "Business", "Finance",
    "Economics", "Biology", "Medicine/Health", "Design", "Humanities", "Law",
    "General Study",
  ],
  Teacher: [
    "School Teaching", "Higher Education", "Test Prep", "Curriculum Design",
    "Educational Technology", "Training/L&D", "Academic Mentoring",
  ],
  Employee: [
    "Software Engineering", "Data/Analytics", "AI/ML", "Product", "Design",
    "Marketing", "Sales", "Finance", "Operations", "HR", "Consulting",
    "General Office Work",
  ],
  Researcher: [
    "Computer Science", "AI/ML", "Data Science", "Biology/Life Sciences",
    "Chemistry", "Physics", "Social Science", "Economics/Finance",
    "Engineering", "Literature/Humanities",
  ],
  Freelancer: [
    "Web Development", "App Development", "UI/UX", "Content Writing",
    "Copywriting", "Marketing", "Data/Research Services", "Consulting",
    "Design", "No-code/Automation",
  ],
  Entrepreneur: [
    "Startup/Product", "Growth/Marketing", "Sales", "Operations", "Finance",
    "Fundraising", "Strategy", "Hiring/HR", "Tech/Product", "Agency/Services",
  ],
};

export const EXPERIENCE_LEVELS = [
  "Beginner", "Intermediate", "Advanced", "Expert",
] as const;

export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

/** Categories describe what the user is trying to do, not how it is stored. */
export const CATEGORIES = [
  "STUDY", "WRITING", "RESEARCH", "CODING", "ANALYSIS", "DESIGN",
  "PRESENTATION", "CAREER", "BUSINESS", "MARKETING", "FINANCE",
  "PRODUCTIVITY", "COMMUNICATION", "OPERATIONS", "STRATEGY", "OTHER",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Display names, so no screen renders a raw enum. */
export const CATEGORY_LABEL: Record<string, string> = {
  STUDY: "Study",
  WRITING: "Writing",
  RESEARCH: "Research",
  CODING: "Coding",
  ANALYSIS: "Data/Analysis",
  DESIGN: "Design",
  PRESENTATION: "Presentation",
  CAREER: "Career",
  BUSINESS: "Business",
  MARKETING: "Marketing",
  FINANCE: "Finance",
  PRODUCTIVITY: "Productivity",
  COMMUNICATION: "Communication",
  OPERATIONS: "Operations",
  STRATEGY: "Strategy",
  OTHER: "Other",
};

export const categoryLabel = (v: string) => CATEGORY_LABEL[v] ?? v;

export function isRole(v: string): v is Role {
  return (ROLES as readonly string[]).includes(v);
}

/** The specializations valid for a role, or an empty list for an unknown one. */
export function specializationsFor(role: string): string[] {
  return isRole(role) ? SPECIALIZATIONS[role] : [];
}

/**
 * Whether a specialization belongs to a role. Changing role must clear a
 * specialization that no longer applies, rather than leaving "SDE" attached
 * to a Teacher and quietly skewing every recommendation afterwards.
 */
export function isValidSpecialization(role: string, specialization: string): boolean {
  return specializationsFor(role).includes(specialization);
}

/** The first specialization for a role - the sensible default after a change. */
export function defaultSpecialization(role: string): string {
  return specializationsFor(role)[0] ?? "Other";
}

/**
 * Category affinity by role, then by specialization. Data, so adding a role
 * needs no code change.
 */
export const ROLE_CATEGORIES: Record<string, Category[]> = {
  Student: ["STUDY", "RESEARCH", "WRITING", "CODING", "PRESENTATION"],
  Teacher: ["STUDY", "PRESENTATION", "WRITING", "COMMUNICATION", "RESEARCH"],
  Employee: ["PRODUCTIVITY", "COMMUNICATION", "ANALYSIS", "WRITING", "CAREER"],
  Researcher: ["RESEARCH", "ANALYSIS", "WRITING", "STUDY"],
  Freelancer: ["BUSINESS", "WRITING", "DESIGN", "MARKETING", "PRODUCTIVITY"],
  Entrepreneur: ["BUSINESS", "STRATEGY", "MARKETING", "FINANCE", "PRESENTATION"],
};

export const SPECIALIZATION_CATEGORIES: Record<string, Category[]> = {
  // Student
  Engineering: ["CODING", "STUDY", "ANALYSIS"],
  "Computer Science": ["CODING", "STUDY", "ANALYSIS"],
  "Data Science": ["ANALYSIS", "CODING", "RESEARCH"],
  Business: ["BUSINESS", "STRATEGY", "PRESENTATION"],
  Economics: ["ANALYSIS", "RESEARCH", "FINANCE"],
  Biology: ["RESEARCH", "STUDY"],
  "Medicine/Health": ["RESEARCH", "STUDY", "COMMUNICATION"],
  Humanities: ["WRITING", "RESEARCH", "STUDY"],
  Law: ["RESEARCH", "WRITING", "STRATEGY"],
  "General Study": ["STUDY", "WRITING"],

  // Teacher
  "School Teaching": ["STUDY", "COMMUNICATION", "PRESENTATION"],
  "Higher Education": ["RESEARCH", "STUDY", "PRESENTATION"],
  "Test Prep": ["STUDY", "PRESENTATION"],
  "Curriculum Design": ["STUDY", "STRATEGY", "WRITING"],
  "Educational Technology": ["CODING", "DESIGN", "STUDY"],
  "Training/L&D": ["COMMUNICATION", "PRESENTATION", "CAREER"],
  "Academic Mentoring": ["CAREER", "COMMUNICATION", "STUDY"],

  // Employee
  "Software Engineering": ["CODING", "ANALYSIS", "PRODUCTIVITY"],
  "Data/Analytics": ["ANALYSIS", "CODING", "PRESENTATION"],
  "AI/ML": ["CODING", "RESEARCH", "ANALYSIS"],
  Product: ["STRATEGY", "BUSINESS", "PRESENTATION"],
  Design: ["DESIGN", "PRESENTATION", "RESEARCH"],
  Marketing: ["MARKETING", "WRITING", "BUSINESS"],
  Sales: ["COMMUNICATION", "BUSINESS", "MARKETING"],
  Finance: ["FINANCE", "ANALYSIS", "BUSINESS"],
  Operations: ["OPERATIONS", "PRODUCTIVITY", "ANALYSIS"],
  HR: ["CAREER", "COMMUNICATION", "OPERATIONS"],
  Consulting: ["STRATEGY", "ANALYSIS", "PRESENTATION"],
  "General Office Work": ["PRODUCTIVITY", "COMMUNICATION", "WRITING"],

  // Researcher
  "Biology/Life Sciences": ["RESEARCH", "ANALYSIS"],
  Chemistry: ["RESEARCH", "ANALYSIS"],
  Physics: ["RESEARCH", "ANALYSIS"],
  "Social Science": ["RESEARCH", "WRITING", "ANALYSIS"],
  "Economics/Finance": ["FINANCE", "ANALYSIS", "RESEARCH"],
  "Literature/Humanities": ["WRITING", "RESEARCH"],

  // Freelancer
  "Web Development": ["CODING", "DESIGN", "BUSINESS"],
  "App Development": ["CODING", "DESIGN"],
  "UI/UX": ["DESIGN", "RESEARCH", "PRESENTATION"],
  "Content Writing": ["WRITING", "MARKETING"],
  Copywriting: ["WRITING", "MARKETING"],
  "Data/Research Services": ["ANALYSIS", "RESEARCH"],
  "No-code/Automation": ["PRODUCTIVITY", "OPERATIONS", "CODING"],

  // Entrepreneur
  "Startup/Product": ["STRATEGY", "BUSINESS", "PRESENTATION"],
  "Growth/Marketing": ["MARKETING", "BUSINESS", "ANALYSIS"],
  Fundraising: ["PRESENTATION", "FINANCE", "STRATEGY"],
  Strategy: ["STRATEGY", "BUSINESS", "ANALYSIS"],
  "Hiring/HR": ["CAREER", "COMMUNICATION"],
  "Tech/Product": ["CODING", "STRATEGY", "PRODUCTIVITY"],
  "Agency/Services": ["BUSINESS", "MARKETING", "OPERATIONS"],
};
