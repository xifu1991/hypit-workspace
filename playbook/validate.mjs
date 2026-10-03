#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const playbookDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.dirname(playbookDirectory);
const errors = [];
const warnings = [];
const expectedStageIds = [
  "topic",
  "reference",
  "materials",
  "arrangement",
  "components",
  "motion",
  "qa",
  "publish-retrospective"
];
const templateMap = {
  brief: "brief.template.json",
  reference: "reference.template.json",
  "material-plan": "material-plan.template.json",
  shotbook: "shotbook.template.json",
  "component-plan": "component-plan.template.json",
  qa: "qa.template.json",
  retrospective: "retrospective.template.json"
};
const componentStatuses = new Set(["planned", "draft", "analyzed", "verified", "retired"]);
const requiredQaChecks = new Set([
  "hook-first-3s",
  "reference-structure",
  "pacing-density",
  "caption-sync",
  "fact-accuracy",
  "media-integrity",
  "authorization"
]);

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) {
    fail(`${label} must be an object.`);
    return false;
  }
  return true;
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    fail(`${label} must be a non-empty string.`);
    return false;
  }
  return true;
}

function requireNumber(value, label, { integer = false, minimum = null } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (integer && !Number.isInteger(value))) {
    fail(`${label} must be ${integer ? "an integer" : "a finite number"}.`);
    return false;
  }
  if (minimum !== null && value < minimum) {
    fail(`${label} must be >= ${minimum}.`);
    return false;
  }
  return true;
}

function requireArray(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? "an array" : "a non-empty array"}.`);
    return false;
  }
  return true;
}

function readJson(absolutePath, label) {
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    fail(`${label} cannot be parsed: ${error.message}`);
    return null;
  }
}

function pathExists(absolutePath) {
  try {
    fs.accessSync(absolutePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function validatePlaybook(playbook) {
  if (!requireObject(playbook, "playbook.json")) {
    return null;
  }
  if (playbook.format !== "hypit.video-playbook@1") {
    fail("playbook.json format must be hypit.video-playbook@1.");
  }
  requireString(playbook.version, "playbook.json version");
  requireString(playbook.purpose, "playbook.json purpose");
  if (!Array.isArray(playbook.principles) || playbook.principles.length === 0) {
    fail("playbook.json principles must be a non-empty array.");
  }
  if (!requireArray(playbook.stages, "playbook.json stages")) {
    return playbook;
  }
  if (playbook.stages.length !== expectedStageIds.length) {
    fail(`playbook.json must contain ${expectedStageIds.length} stages.`);
  }

  const ids = [];
  for (const [index, stage] of playbook.stages.entries()) {
    const label = `playbook.json stages[${index}]`;
    if (!requireObject(stage, label)) {
      continue;
    }
    requireString(stage.id, `${label}.id`);
    requireString(stage.name, `${label}.name`);
    requireString(stage.goal, `${label}.goal`);
    requireNumber(stage.order, `${label}.order`, { integer: true, minimum: 1 });
    for (const field of ["requiredInputs", "actions", "outputs", "gates", "failurePolicy"]) {
      requireArray(stage[field], `${label}.${field}`);
    }
    if (stage.id === expectedStageIds[index]) {
      ids.push(stage.id);
    } else {
      fail(`${label}.id must be ${expectedStageIds[index]}.`);
      ids.push(stage.id);
    }
    if (stage.order !== index + 1) {
      fail(`${label}.order must be ${index + 1}.`);
    }
  }
  if (new Set(ids).size !== ids.length) {
    fail("playbook.json stage ids must be unique.");
  }

  if (!requireObject(playbook.artifacts, "playbook.json artifacts")) {
    return playbook;
  }
  for (const stage of playbook.stages) {
    const artifact = playbook.artifacts[stage.id];
    if (!artifact && stage.id !== "motion") {
      fail(`playbook.json artifacts.${stage.id} is required.`);
      continue;
    }
    if (!artifact) {
      continue;
    }
    requireString(artifact.output, `playbook.json artifacts.${stage.id}.output`);
    if (!requireString(artifact.template, `playbook.json artifacts.${stage.id}.template`)) {
      continue;
    }
    const templatePath = path.resolve(playbookDirectory, artifact.template);
    if (!pathExists(templatePath)) {
      fail(`Template referenced by artifacts.${stage.id} does not exist: ${artifact.template}`);
    }
  }

  if (!requireObject(playbook.rules, "playbook.json rules")) {
    return playbook;
  }
  for (const rule of [
    "stageOrderIsMandatory",
    "skipRequiresExplicitApproval",
    "unverifiedStyleCannotBePromoted",
    "unverifiedComponentCannotShip",
    "referenceBrandAssetsCannotShip"
  ]) {
    if (playbook.rules[rule] !== true) {
      fail(`playbook.json rules.${rule} must be true.`);
    }
  }
  return playbook;
}

function validateBrief(brief, label, { strict = false } = {}) {
  if (!requireObject(brief, label)) {
    return;
  }
  if (brief.format !== "hypit.video-brief@1") {
    fail(`${label}.format must be hypit.video-brief@1.`);
  }
  requireString(brief.status, `${label}.status`);
  requireString(brief.projectId, `${label}.projectId`, { allowEmpty: !strict });
  requireString(brief.coreQuestion, `${label}.coreQuestion`, { allowEmpty: !strict });
  requireObject(brief.audience, `${label}.audience`);
  if (isObject(brief.audience)) {
    requireString(brief.audience.primary, `${label}.audience.primary`, { allowEmpty: !strict });
    requireString(brief.audience.currentSituation, `${label}.audience.currentSituation`, { allowEmpty: !strict });
    requireString(brief.audience.desiredChange, `${label}.audience.desiredChange`, { allowEmpty: !strict });
  }
  requireString(brief.singleTakeaway, `${label}.singleTakeaway`, { allowEmpty: !strict });
  requireString(brief.productOrSubject, `${label}.productOrSubject`, { allowEmpty: !strict });
  if (requireObject(brief.platform, `${label}.platform`)) {
    requireString(brief.platform.name, `${label}.platform.name`, { allowEmpty: !strict });
    requireString(brief.platform.aspectRatio, `${label}.platform.aspectRatio`);
    requireNumber(brief.platform.width, `${label}.platform.width`, { integer: true, minimum: 1 });
    requireNumber(brief.platform.height, `${label}.platform.height`, { integer: true, minimum: 1 });
    requireNumber(brief.platform.fps, `${label}.platform.fps`, { integer: true, minimum: 1 });
  }
  if (requireObject(brief.duration, `${label}.duration`)) {
    requireNumber(brief.duration.targetSeconds, `${label}.duration.targetSeconds`, { minimum: 0 });
    requireNumber(brief.duration.minSeconds, `${label}.duration.minSeconds`, { minimum: 0 });
    requireNumber(brief.duration.maxSeconds, `${label}.duration.maxSeconds`, { minimum: 0 });
    if (strict && brief.duration.targetSeconds <= 0) {
      fail(`${label}.duration.targetSeconds must be > 0 for an approved or locked brief.`);
    }
    if (
      typeof brief.duration.minSeconds === "number" &&
      typeof brief.duration.targetSeconds === "number" &&
      brief.duration.targetSeconds < brief.duration.minSeconds
    ) {
      fail(`${label}.duration.targetSeconds must be >= minSeconds.`);
    }
    if (
      typeof brief.duration.maxSeconds === "number" &&
      typeof brief.duration.targetSeconds === "number" &&
      brief.duration.targetSeconds > brief.duration.maxSeconds
    ) {
      fail(`${label}.duration.targetSeconds must be <= maxSeconds.`);
    }
  }
  requireArray(brief.facts, `${label}.facts`, { allowEmpty: true });
  requireArray(brief.constraints, `${label}.constraints`, { allowEmpty: true });
  requireArray(brief.prohibitedDirections, `${label}.prohibitedDirections`, { allowEmpty: true });
  if (!requireObject(brief.approval, `${label}.approval`)) {
    return;
  }
  if (typeof brief.approval.topicLocked !== "boolean") {
    fail(`${label}.approval.topicLocked must be a boolean.`);
  }
  if (strict && brief.approval.topicLocked !== true) {
    fail(`${label}.approval.topicLocked must be true for an approved or locked brief.`);
  }
}

function validateReference(reference, label, { strict = false } = {}) {
  if (!requireObject(reference, label)) {
    return;
  }
  if (reference.format !== "hypit.video-reference@1") {
    fail(`${label}.format must be hypit.video-reference@1.`);
  }
  requireString(reference.status, `${label}.status`);
  requireString(reference.projectId, `${label}.projectId`, { allowEmpty: !strict });
  requireString(reference.briefPath, `${label}.briefPath`);
  if (requireArray(reference.sources, `${label}.sources`)) {
    for (const [index, source] of reference.sources.entries()) {
      const sourceLabel = `${label}.sources[${index}]`;
      if (!requireObject(source, sourceLabel)) {
        continue;
      }
      requireString(source.label, `${sourceLabel}.label`);
      requireString(source.role, `${sourceLabel}.role`);
      if (strict) {
        requireString(source.sha256, `${sourceLabel}.sha256`);
        if (!/^[A-Fa-f0-9]{64}$/.test(source.sha256)) {
          fail(`${sourceLabel}.sha256 must be a 64-character SHA-256 value.`);
        }
      }
      requireObject(source.timeRange, `${sourceLabel}.timeRange`);
    }
  }
  requireArray(reference.selectedStyleIds, `${label}.selectedStyleIds`, { allowEmpty: true });
  if (!requireObject(reference.structure, `${label}.structure`)) {
    return;
  }
  const structure = reference.structure;
  requireString(structure.narrativePattern, `${label}.structure.narrativePattern`, { allowEmpty: !strict });
  requireObject(structure.hook, `${label}.structure.hook`);
  requireObject(structure.pacing, `${label}.structure.pacing`);
  requireString(structure.informationDensity, `${label}.structure.informationDensity`, { allowEmpty: !strict });
  requireArray(structure.shotLanguage, `${label}.structure.shotLanguage`, { allowEmpty: !strict });
  requireArray(structure.captionSystem, `${label}.structure.captionSystem`, { allowEmpty: !strict });
  requireArray(structure.transitions, `${label}.structure.transitions`, { allowEmpty: true });
  requireString(structure.ending, `${label}.structure.ending`, { allowEmpty: !strict });
  if (requireArray(reference.evidenceFrames, `${label}.evidenceFrames`)) {
    for (const [index, frame] of reference.evidenceFrames.entries()) {
      const frameLabel = `${label}.evidenceFrames[${index}]`;
      if (!requireObject(frame, frameLabel)) {
        continue;
      }
      requireNumber(frame.timeSeconds, `${frameLabel}.timeSeconds`, { minimum: 0 });
      requireString(frame.path, `${frameLabel}.path`, { allowEmpty: !strict });
      requireString(frame.observation, `${frameLabel}.observation`, { allowEmpty: !strict });
    }
  }
  requireArray(reference.reusablePatterns, `${label}.reusablePatterns`, { allowEmpty: !strict });
  requireArray(reference.forbiddenReuse, `${label}.forbiddenReuse`);
  requireObject(reference.originality, `${label}.originality`);
}

function validateMaterialPlan(plan, label, { strict = false } = {}) {
  if (!requireObject(plan, label)) {
    return;
  }
  if (plan.format !== "hypit.material-plan@1") {
    fail(`${label}.format must be hypit.material-plan@1.`);
  }
  requireString(plan.status, `${label}.status`);
  requireString(plan.projectId, `${label}.projectId`, { allowEmpty: !strict });
  requireString(plan.briefPath, `${label}.briefPath`);
  requireString(plan.referencePath, `${label}.referencePath`);
  if (!requireArray(plan.arguments, `${label}.arguments`)) {
    return;
  }
  const ids = new Set();
  for (const [index, argument] of plan.arguments.entries()) {
    const argumentLabel = `${label}.arguments[${index}]`;
    if (!requireObject(argument, argumentLabel)) {
      continue;
    }
    requireString(argument.id, `${argumentLabel}.id`);
    if (ids.has(argument.id)) {
      fail(`${argumentLabel}.id must be unique.`);
    }
    ids.add(argument.id);
    requireString(argument.claim, `${argumentLabel}.claim`, { allowEmpty: !strict });
    requireString(argument.role, `${argumentLabel}.role`);
    if (requireArray(argument.assets, `${argumentLabel}.assets`)) {
      for (const [assetIndex, asset] of argument.assets.entries()) {
        const assetLabel = `${argumentLabel}.assets[${assetIndex}]`;
        if (!requireObject(asset, assetLabel)) {
          continue;
        }
        requireString(asset.id, `${assetLabel}.id`);
        requireString(asset.path, `${assetLabel}.path`, { allowEmpty: !strict });
        requireString(asset.mediaType, `${assetLabel}.mediaType`);
        requireString(asset.source, `${assetLabel}.source`, { allowEmpty: !strict });
        requireObject(asset.license, `${assetLabel}.license`);
        requireString(asset.availability, `${assetLabel}.availability`);
        if (strict) {
          if (asset.availability !== "ready") {
            fail(`${assetLabel}.availability must be ready for an approved material plan.`);
          }
          if (asset.license.status === "unknown") {
            fail(`${assetLabel}.license.status cannot be unknown for an approved material plan.`);
          }
        }
      }
    }
    requireString(argument.coverage, `${argumentLabel}.coverage`);
    requireString(argument.gap, `${argumentLabel}.gap`, { allowEmpty: true });
    if (strict && argument.coverage !== "complete") {
      fail(`${argumentLabel}.coverage must be complete for an approved material plan.`);
    }
  }
}

function validateShotbook(shotbook, label, { strict = false } = {}) {
  if (!requireObject(shotbook, label)) {
    return;
  }
  if (shotbook.format !== "hypit.shotbook@1") {
    fail(`${label}.format must be hypit.shotbook@1.`);
  }
  requireString(shotbook.status, `${label}.status`);
  requireString(shotbook.projectId, `${label}.projectId`, { allowEmpty: !strict });
  requireString(shotbook.briefPath, `${label}.briefPath`);
  requireString(shotbook.referencePath, `${label}.referencePath`);
  requireString(shotbook.materialPlanPath, `${label}.materialPlanPath`);
  requireString(shotbook.timelineSemantics, `${label}.timelineSemantics`);
  if (requireObject(shotbook.canvas, `${label}.canvas`)) {
    requireNumber(shotbook.canvas.width, `${label}.canvas.width`, { integer: true, minimum: 1 });
    requireNumber(shotbook.canvas.height, `${label}.canvas.height`, { integer: true, minimum: 1 });
    requireString(shotbook.canvas.aspectRatio, `${label}.canvas.aspectRatio`);
  }
  requireNumber(shotbook.fps, `${label}.fps`, { integer: true, minimum: 1 });
  requireNumber(shotbook.totalFrames, `${label}.totalFrames`, { integer: true, minimum: 0 });
  if (!requireArray(shotbook.shots, `${label}.shots`)) {
    return;
  }
  const ids = new Set();
  let previousEnd = 0;
  const validateTimeline = strict || shotbook.totalFrames > 0;
  for (const [index, shot] of shotbook.shots.entries()) {
    const shotLabel = `${label}.shots[${index}]`;
    if (!requireObject(shot, shotLabel)) {
      continue;
    }
    requireString(shot.id, `${shotLabel}.id`);
    if (ids.has(shot.id)) {
      fail(`${shotLabel}.id must be unique.`);
    }
    ids.add(shot.id);
    requireNumber(shot.order, `${shotLabel}.order`, { integer: true, minimum: 1 });
    if (shot.order !== index + 1) {
      fail(`${shotLabel}.order must be ${index + 1}.`);
    }
    const hasStart = requireNumber(shot.startFrame, `${shotLabel}.startFrame`, { integer: true, minimum: 0 });
    const hasEnd = requireNumber(shot.endFrame, `${shotLabel}.endFrame`, { integer: true, minimum: 0 });
    if (validateTimeline && hasStart && hasEnd) {
      if (shot.startFrame !== previousEnd) {
        fail(`${shotLabel}.startFrame must equal the previous shot endFrame (${previousEnd}).`);
      }
      if (shot.endFrame <= shot.startFrame) {
        fail(`${shotLabel}.endFrame must be greater than startFrame.`);
      }
      previousEnd = shot.endFrame;
    }
    requireString(shot.purpose, `${shotLabel}.purpose`, { allowEmpty: !strict });
    requireObject(shot.referenceMapping, `${shotLabel}.referenceMapping`);
    requireString(shot.narration, `${shotLabel}.narration`, { allowEmpty: true });
    if (requireObject(shot.visual, `${shotLabel}.visual`)) {
      requireArray(shot.visual.assetIds, `${shotLabel}.visual.assetIds`, { allowEmpty: !strict });
      requireString(shot.visual.description, `${shotLabel}.visual.description`, { allowEmpty: !strict });
      requireString(shot.visual.subjectFocus, `${shotLabel}.visual.subjectFocus`, { allowEmpty: !strict });
      requireString(shot.visual.framing, `${shotLabel}.visual.framing`, { allowEmpty: !strict });
      requireString(shot.visual.crop, `${shotLabel}.visual.crop`, { allowEmpty: !strict });
    }
    requireArray(shot.captions, `${shotLabel}.captions`, { allowEmpty: true });
    requireString(shot.layout, `${shotLabel}.layout`, { allowEmpty: !strict });
    requireArray(shot.components, `${shotLabel}.components`, { allowEmpty: true });
    requireArray(shot.motion, `${shotLabel}.motion`, { allowEmpty: true });
    requireObject(shot.audio, `${shotLabel}.audio`);
    requireArray(shot.acceptanceCriteria, `${shotLabel}.acceptanceCriteria`, { allowEmpty: !strict });
  }
  if (validateTimeline && previousEnd !== shotbook.totalFrames) {
    fail(`${label}: final shot endFrame must equal totalFrames (${shotbook.totalFrames}).`);
  }
}

function validateComponentPlan(plan, label, library, { strict = false } = {}) {
  if (!requireObject(plan, label)) {
    return;
  }
  if (plan.format !== "hypit.component-plan@1") {
    fail(`${label}.format must be hypit.component-plan@1.`);
  }
  requireString(plan.status, `${label}.status`);
  requireString(plan.projectId, `${label}.projectId`, { allowEmpty: !strict });
  requireString(plan.shotbookPath, `${label}.shotbookPath`);
  if (!requireArray(plan.components, `${label}.components`)) {
    return;
  }
  const libraryById = new Map(library.components.map((component) => [component.id, component]));
  for (const [index, entry] of plan.components.entries()) {
    const entryLabel = `${label}.components[${index}]`;
    if (!requireObject(entry, entryLabel)) {
      continue;
    }
    requireString(entry.id, `${entryLabel}.id`);
    requireString(entry.shotId, `${entryLabel}.shotId`);
    requireString(entry.slot, `${entryLabel}.slot`);
    const hasComponentId = typeof entry.componentId === "string" && entry.componentId.trim() !== "";
    const hasVersion = typeof entry.version === "string" && entry.version.trim() !== "";
    if (strict && !hasComponentId) {
      fail(`${entryLabel}.componentId must be a non-empty string.`);
    }
    if (strict && !hasVersion) {
      fail(`${entryLabel}.version must be a non-empty string.`);
    }
    requireString(entry.requiredStatus, `${entryLabel}.requiredStatus`);
    requireObject(entry.overrides, `${entryLabel}.overrides`);
    requireArray(entry.assetReplacements, `${entryLabel}.assetReplacements`, { allowEmpty: true });
    requireObject(entry.license, `${entryLabel}.license`);
    if (!hasComponentId) {
      continue;
    }
    const component = libraryById.get(entry.componentId);
    if (!component) {
      fail(`${entryLabel}.componentId is not registered: ${entry.componentId}`);
      continue;
    }
    if (hasVersion && component.latestVersion !== entry.version) {
      fail(`${entryLabel}.version ${entry.version} does not match component latestVersion ${component.latestVersion}.`);
    }
    if (entry.requiredStatus === "verified" && component.status !== "verified") {
      fail(`${entryLabel} requires verified, but ${component.id} is ${component.status}.`);
    }
    if (strict && component.status !== "verified") {
      fail(`${entryLabel} cannot ship because ${component.id} is ${component.status}.`);
    }
  }
}

function validateQa(qa, label, projectRoot, { strict = false } = {}) {
  if (!requireObject(qa, label)) {
    return;
  }
  if (qa.format !== "hypit.qa-report@1") {
    fail(`${label}.format must be hypit.qa-report@1.`);
  }
  requireString(qa.status, `${label}.status`);
  requireString(qa.projectId, `${label}.projectId`, { allowEmpty: !strict });
  requireString(qa.shotbookPath, `${label}.shotbookPath`);
  requireObject(qa.artifacts, `${label}.artifacts`);
  if (!requireArray(qa.checks, `${label}.checks`)) {
    return;
  }
  const seen = new Set();
  for (const [index, check] of qa.checks.entries()) {
    const checkLabel = `${label}.checks[${index}]`;
    if (!requireObject(check, checkLabel)) {
      continue;
    }
    requireString(check.id, `${checkLabel}.id`);
    if (seen.has(check.id)) {
      fail(`${checkLabel}.id must be unique.`);
    }
    seen.add(check.id);
    requireString(check.label, `${checkLabel}.label`);
    requireString(check.status, `${checkLabel}.status`);
    requireString(check.severity, `${checkLabel}.severity`);
    requireString(check.evidence, `${checkLabel}.evidence`, { allowEmpty: check.status === "pending" });
  }
  for (const requiredCheck of requiredQaChecks) {
    if (!seen.has(requiredCheck)) {
      fail(`${label}.checks is missing required check: ${requiredCheck}.`);
    }
  }
  requireArray(qa.blockingIssues, `${label}.blockingIssues`, { allowEmpty: true });
  requireString(qa.finalVerdict, `${label}.finalVerdict`);
  if (strict) {
    const unresolved = qa.checks.filter((check) => check.severity === "blocking" && check.status !== "pass");
    if (unresolved.length > 0) {
      fail(`${label} has ${unresolved.length} unresolved blocking check(s).`);
    }
    if (qa.blockingIssues.length > 0) {
      fail(`${label}.blockingIssues must be empty for a passing report.`);
    }
    if (qa.finalVerdict !== "pass") {
      fail(`${label}.finalVerdict must be pass for an approved QA report.`);
    }
    const outputVideoPath = qa.artifacts.outputVideoPath;
    if (requireString(outputVideoPath, `${label}.artifacts.outputVideoPath`)) {
      const absoluteOutput = path.resolve(projectRoot, outputVideoPath);
      if (!pathExists(absoluteOutput) || fs.statSync(absoluteOutput).size === 0) {
        fail(`${label}.artifacts.outputVideoPath must point to a non-empty rendered video.`);
      }
    }
  }
}

function validateRetrospective(retrospective, label, { strict = false } = {}) {
  if (!requireObject(retrospective, label)) {
    return;
  }
  if (retrospective.format !== "hypit.video-retrospective@1") {
    fail(`${label}.format must be hypit.video-retrospective@1.`);
  }
  requireString(retrospective.status, `${label}.status`);
  requireString(retrospective.projectId, `${label}.projectId`, { allowEmpty: !strict });
  requireString(retrospective.qaPath, `${label}.qaPath`);
  if (requireObject(retrospective.publication, `${label}.publication`)) {
    requireString(retrospective.publication.status, `${label}.publication.status`);
    if (strict && retrospective.publication.status === "published") {
      requireString(retrospective.publication.platform, `${label}.publication.platform`);
      requireString(retrospective.publication.publishedAt, `${label}.publication.publishedAt`);
    }
    if (strict && retrospective.publication.status === "not-published") {
      requireString(
        retrospective.publication.reasonIfNotPublished,
        `${label}.publication.reasonIfNotPublished`
      );
    }
  }
  requireObject(retrospective.metrics, `${label}.metrics`);
  requireObject(retrospective.retention, `${label}.retention`);
  requireObject(retrospective.comments, `${label}.comments`);
  if (requireArray(retrospective.learnings, `${label}.learnings`)) {
    for (const [index, learning] of retrospective.learnings.entries()) {
      const learningLabel = `${label}.learnings[${index}]`;
      if (!requireObject(learning, learningLabel)) {
        continue;
      }
      requireString(learning.observation, `${learningLabel}.observation`, { allowEmpty: !strict });
      requireString(learning.evidence, `${learningLabel}.evidence`, { allowEmpty: !strict });
      requireString(learning.action, `${learningLabel}.action`);
      requireString(learning.updateTarget, `${learningLabel}.updateTarget`);
    }
  }
  requireArray(retrospective.libraryUpdates, `${label}.libraryUpdates`, { allowEmpty: true });
}

function validateTemplates() {
  const templates = {};
  for (const [name, fileName] of Object.entries(templateMap)) {
    const absolutePath = path.join(playbookDirectory, "templates", fileName);
    if (!pathExists(absolutePath)) {
      fail(`Template is missing: playbook/templates/${fileName}`);
      continue;
    }
    const template = readJson(absolutePath, `playbook/templates/${fileName}`);
    if (!template) {
      continue;
    }
    templates[name] = template;
    requireString(template.format, `${fileName} format`);
    requireString(template.status, `${fileName} status`);
  }
  if (templates.brief) {
    validateBrief(templates.brief, "brief.template.json");
  }
  if (templates.reference) {
    validateReference(templates.reference, "reference.template.json");
  }
  if (templates["material-plan"]) {
    validateMaterialPlan(templates["material-plan"], "material-plan.template.json");
  }
  if (templates.shotbook) {
    validateShotbook(templates.shotbook, "shotbook.template.json");
  }
  if (templates.qa) {
    validateQa(templates.qa, "qa.template.json", playbookDirectory);
  }
  if (templates.retrospective) {
    validateRetrospective(templates.retrospective, "retrospective.template.json");
  }
  return templates;
}

function validateComponentLibrary(library) {
  if (!requireObject(library, "component-library/index.json")) {
    return { components: [] };
  }
  if (library.format !== "hypit.component-library@1") {
    fail("component-library/index.json format must be hypit.component-library@1.");
  }
  requireString(library.updatedAt, "component-library/index.json updatedAt");
  if (requireObject(library.policy, "component-library/index.json policy")) {
    if (!Array.isArray(library.policy.validStatuses) || library.policy.validStatuses.length === 0) {
      fail("component-library/index.json policy.validStatuses must be a non-empty array.");
    }
    if (library.policy.shipRequires !== "verified") {
      fail("component-library/index.json policy.shipRequires must be verified.");
    }
  }
  const ids = new Set();
  if (!requireArray(library.components, "component-library/index.json components")) {
    return library;
  }
  for (const [index, component] of library.components.entries()) {
    const label = `component-library/index.json components[${index}]`;
    if (!requireObject(component, label)) {
      continue;
    }
    requireString(component.id, `${label}.id`);
    if (ids.has(component.id)) {
      fail(`${label}.id must be unique.`);
    }
    ids.add(component.id);
    requireString(component.name, `${label}.name`);
    requireString(component.kind, `${label}.kind`);
    requireString(component.latestVersion, `${label}.latestVersion`);
    if (!componentStatuses.has(component.status)) {
      fail(`${label}.status must be one of: ${[...componentStatuses].join(", ")}.`);
    }
    requireArray(component.tags, `${label}.tags`, { allowEmpty: true });
    requireArray(component.slots, `${label}.slots`);
    requireObject(component.source, `${label}.source`);
    requireObject(component.integration, `${label}.integration`);
    requireArray(component.inputs, `${label}.inputs`);
    requireArray(component.evidence, `${label}.evidence`, { allowEmpty: true });
    requireObject(component.license, `${label}.license`);
    if (component.status === "verified" && component.evidence.length === 0) {
      fail(`${label} is verified but has no rendered evidence.`);
    }
  }
  return library;
}

function validateProject(projectRoot, library) {
  if (!pathExists(projectRoot)) {
    fail(`Project directory does not exist: ${projectRoot}`);
    return;
  }
  const artifacts = {
    brief: { file: "brief.json", validator: validateBrief },
    reference: { file: "reference.json", validator: validateReference },
    "material-plan": { file: "material-plan.json", validator: validateMaterialPlan },
    shotbook: { file: "shotbook.json", validator: validateShotbook },
    "component-plan": {
      file: "component-plan.json",
      validator: (value, label, options) => validateComponentPlan(value, label, library, options)
    },
    qa: { file: "qa.json", validator: validateQa },
    retrospective: { file: "retrospective.json", validator: validateRetrospective }
  };
  const loaded = {};
  let downstreamExists = false;
  for (const [stage, artifact] of Object.entries(artifacts).reverse()) {
    const absolutePath = path.join(projectRoot, artifact.file);
    if (!pathExists(absolutePath)) {
      continue;
    }
    downstreamExists = true;
    const value = readJson(absolutePath, artifact.file);
    if (!value) {
      continue;
    }
    loaded[stage] = value;
    const strict = value.status === "approved" || value.status === "locked" || value.status === "pass";
    const options = { strict };
    if (stage === "qa") {
      artifact.validator(value, artifact.file, projectRoot, options);
    } else {
      artifact.validator(value, artifact.file, options);
    }
  }
  if (downstreamExists && !pathExists(path.join(projectRoot, "brief.json"))) {
    fail("Project has downstream artifacts but is missing brief.json.");
  }
  if (loaded.reference) {
    const styleSelection = loaded.reference.selectedStyleIds ?? [];
    if (styleSelection.length > 0) {
      const libraryPath = path.join(workspaceRoot, "style-library", "index.json");
      const styleLibrary = readJson(libraryPath, "style-library/index.json");
      const knownStyleIds = new Set((styleLibrary?.styles ?? []).map((style) => style.id));
      for (const styleId of styleSelection) {
        if (!knownStyleIds.has(styleId)) {
          fail(`reference.json selectedStyleIds contains an unknown style: ${styleId}`);
        }
      }
    }
  }
}

function parseArguments(argv) {
  let projectRoot = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project") {
      const value = argv[index + 1];
      if (!value) {
        fail("--project requires a directory path.");
      } else {
        projectRoot = path.resolve(process.cwd(), value);
        index += 1;
      }
    } else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node playbook/validate.mjs [--project <project-directory>]");
      process.exit(0);
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return projectRoot;
}

const projectRoot = parseArguments(process.argv.slice(2));
const playbook = readJson(path.join(playbookDirectory, "playbook.json"), "playbook.json");
validatePlaybook(playbook);
validateTemplates();
const library = validateComponentLibrary(
  readJson(path.join(workspaceRoot, "component-library", "index.json"), "component-library/index.json")
);
if (projectRoot) {
  validateProject(projectRoot, library);
}

if (warnings.length > 0) {
  for (const warning of warnings) {
    console.warn(`WARN  ${warning}`);
  }
}
if (errors.length > 0) {
  for (const error of errors) {
    console.error(`ERROR ${error}`);
  }
  console.error(`\nValidation failed with ${errors.length} error(s).`);
  process.exit(1);
}

console.log("Playbook validation passed.");
console.log(`  Stages:     ${playbook.stages.length}`);
console.log(`  Templates:  ${Object.keys(templateMap).length}`);
console.log(`  Components: ${library.components.length}`);
if (projectRoot) {
  console.log(`  Project:    ${projectRoot}`);
}
