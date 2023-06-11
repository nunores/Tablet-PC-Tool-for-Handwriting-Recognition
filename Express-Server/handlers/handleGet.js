const fs = require("fs").promises; // Note: This assumes you're using a version of Node.js that supports Promise-based fs operations (Node.js v10 or later)
const path = require("path");
const util = require("util");
const xml2js = require("xml2js");
const { exec } = require("child_process");

const { PATH } = require("../utils/constants");
const {
  extractAllInformation,
  createFileFromInfo,
} = require("../utils/fileUtils");

/**
 * Returns an array of Seshat commands based on an array of last written numbers.
 *
 * @param {Array} lastWrittenNumbers - An array of last written numbers.
 * @returns {Array} - An array of Seshat commands.
 */
function buildSeshatCommands(lastWrittenNumbers) {
  return lastWrittenNumbers.map(
    (number) =>
      `cd ${PATH} && ./seshat -c Config/CONFIG -i temp/temp${number}.inkml -o out/out${number}.inkml -r render.pgm -d out.dot`
  );
}

/**
 * Extracts the LaTeX expression from the Seshat output string.
 *
 * @param {string} input - The Seshat output string.
 * @returns {string|null} The LaTeX expression if found, null otherwise.
 */
function extractLatexExpression(input) {
  const regex = /LaTeX:\s*(.*)/;
  const matches = input.match(regex);
  return matches[1].trim();
}

/**
 * Updates trace IDs to be unique across all files.
 */
function assignUniqueTraceIDs(traces, traceIdCounter) {
  return {
    updatedTraces: traces.map((trace) => {
      const newTrace = { ...trace, id: String(traceIdCounter) };
      traceIdCounter++;
      return newTrace;
    }),
    traceIdCounter,
  };
}

/**
 * Updates traceDataRefs the traceGroups based on the provided changes
 */
function updateTraceDataRefs(traceGroups, traceIdChanges) {
  const updatedTraceGroups = {};

  for (const group in traceGroups) {
    if (traceGroups.hasOwnProperty(group)) {
      const groupData = { ...traceGroups[group] };
      groupData.traceDataRefs = groupData.traceDataRefs.map(
        (ref) => traceIdChanges[ref]
      );
      updatedTraceGroups[group] = groupData;
    }
  }

  return updatedTraceGroups;
}

/**
 * Updates IDs for trace groups to be unique across all files
 * */
function assignUniqueTraceGroupIDs(traceGroups, groupIdCounter) {
  const updatedTraceGroups = {};

  for (const group in traceGroups) {
    if (traceGroups.hasOwnProperty(group)) {
      updatedTraceGroups[String(groupIdCounter)] = { ...traceGroups[group] };
      groupIdCounter++;
    }
  }

  return { updatedTraceGroups, groupIdCounter };
}

/**
 * Ensures that all IDs are unique
 *
 * @param {Object} outFileAllInfo - All data
 * @returns {Object} The outFileAllInfo with updated to be unique in all files
 */
function modifyIDsToUnique(outFileAllInfo) {
  const modifiedInfo = JSON.parse(JSON.stringify(outFileAllInfo));
  let traceIdCounter = 1;
  let groupIdCounter = 1;

  for (const outFile in modifiedInfo) {
    if (modifiedInfo.hasOwnProperty(outFile)) {
      const inkmlData = modifiedInfo[outFile];

      // Traces
      const { updatedTraces, traceIdCounter: newTraceIdCounter } =
        assignUniqueTraceIDs(inkmlData.traces, traceIdCounter);
      traceIdCounter = newTraceIdCounter; // Need to preserve counter across files

      const traceIdChanges = updatedTraces.reduce((acc, trace, i) => {
        acc[inkmlData.traces[i].id] = trace.id;
        return acc;
      }, {});

      // TraceDataRefs
      const updatedTraceGroups = updateTraceDataRefs(
        inkmlData.traceGroups,
        traceIdChanges
      );

      // TraceGroups
      const {
        updatedTraceGroups: finalTraceGroups,
        groupIdCounter: newGroupIdCounter,
      } = assignUniqueTraceGroupIDs(updatedTraceGroups, groupIdCounter);
      groupIdCounter = newGroupIdCounter;

      inkmlData.traces = updatedTraces;
      inkmlData.traceGroups = finalTraceGroups;
    }
  }

  return modifiedInfo;
}

async function assembleSingleInkML(lastWrittenNumbers) {
  const outFilesAllInfo = await extractAllInformation(lastWrittenNumbers);

  const uniqueIDsInfo = modifyIDsToUnique(outFilesAllInfo);

  createFileFromInfo(uniqueIDsInfo);

  //const finalString = await modifySumAnd3(outInkMLString);

  //console.log("FINAL STRING: ", finalString);
}

function modifyMathTag(mathTag) {
  console.log("MATH TAG: ", mathTag);

  const mrowTags = mathTag.mrow;

  for (let i = 0; i < mrowTags.length; i++) {
    const mrowTag = mrowTags[i];
    const moTag = mrowTag.mo;
    const mnTag = mrowTag.mn;

    if (moTag && moTag[0] === "=" && mnTag && mnTag[mnTag.length - 1] === "3") {
      mrowTag.mo[0] = "=";
      mrowTag.mn[mnTag.length - 1] = "}";
      modifyMsubTag(mrowTag);
    }
  }
}

function modifyMsubTag(mrowTag) {
  const msubTag = mrowTag.msub;

  if (msubTag && msubTag.length > 0) {
    const mrowTagIndex = msubTag.findIndex((subTag) => subTag.mrow);
    if (mrowTagIndex !== -1) {
      const mrowTag = msubTag[mrowTagIndex].mrow[0];
      if (mrowTag) {
        mrowTag.mo[0] = "{";
        mrowTag.mn[mrowTag.mn.length - 1] = "}";
      }
    }
  }
}

module.exports = async function handleGet(req, res) {
  try {
    const lastWrittenNumbers = Array.from(req.query.lastWrittenNumbers, Number);
    const seshatCommands = buildSeshatCommands(lastWrittenNumbers);

    let results = await Promise.all(
      seshatCommands.map(async (command) => {
        const { stdout, stderr } = await util.promisify(exec)(command);
        if (stderr) {
          console.error(`stderr: ${stderr}`);
          throw new Error("Internal Server Error");
        }
        const latexExpression = extractLatexExpression(stdout);
        return latexExpression.replace(/ COMMA /g, ", ");
      })
    );

    const regex =
      /(=|\\lt|\\gt|\\leq|\\geq)_{((\\sum\s*(.*?))|(\\{(.+?)\\})3?)}/;

    for (let [index, result] of results.entries()) {
      // Only odd-indexed results matter (the hint)
      if (index % 2 === 0) continue;

      let match = regex.exec(result);

      if (!match) continue;

      let operator = match[1];
      let hint = match[6] ? match[6].trim() : match[4].replace(/3$/, "").trim();

      // Build the modified hint and replace
      let modifiedHint = `${operator}\\{${hint}\\}`;
      results[index] = modifiedHint;
    }

    results = results.map(
      (result) =>
        result
          .replace(/=_/g, "=") // Remove any underscore
          .replace(/=\{\\{(.+?)\\}\}/g, "={$1}") // Remove extra braces
          .replace(/(_=|_\\lt|_\\gt|_\\leq|_\\geq)/g, (m) => m.slice(1)) // Remove underscore before operators
    );

    console.log("RESULTS: ", results);

    await assembleSingleInkML(lastWrittenNumbers);

    res.send(results);
  } catch (error) {
    console.error(`Error executing commands: ${error}`);
    res.status(500).send("Internal Server Error");
  }
};