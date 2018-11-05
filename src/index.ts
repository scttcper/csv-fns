const RECORD_SEP = String.fromCharCode(30);
const UNIT_SEP = String.fromCharCode(31);
const DEFAULT_DELIMITER = ',';
const fields = []; // Fields are from the header row of the input, if there is one
const FLOAT = /^\s*-?(\d*\.?\d+|\d+\.?\d*)(e[-+]?\d+)?\s*$/i;
const ISO_DATE = /(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))/;
const BYTE_ORDER_MARK = '\ufeff';
const BAD_DELIMITERS = ['\r', '\n', '"', BYTE_ORDER_MARK];

function needsHeaderRow(config) {
  return config.header && fields.length === 0;
}

function fillHeaderFields(results, config) {
  if (!results) {
    return;
  }
  for (let i = 0; needsHeaderRow(config) && i < results.data.length; i++) {
    for (let j = 0; j < results.data[i].length; j++) {
      let header = results.data[i][j];

      if (config.trimHeaders) {
        header = header.trim();
      }

      fields.push(header);
    }
  }
  results.data.splice(0, 1);
  return results;
}

export function guessDelimiter(input, results, newline, skipEmptyLines, comments) {
  const delimChoices = [',', '\t', '|', ';', RECORD_SEP, UNIT_SEP];
  let bestDelim;
  let bestDelta;
  let fieldCountPrevRow;

  for (let i = 0; i < delimChoices.length; i++) {
    const delim = delimChoices[i];
    console.log({ delim });
    let delta = 0;
    let avgFieldCount = 0;
    let emptyLinesCount = 0;
    fieldCountPrevRow = undefined;

    const preview = parse(input, results, {
      comments,
      delimiter: delim,
      newline,
      preview: 10,
    });

    for (let j = 0; j < preview.data.length; j++) {
      if (skipEmptyLines && testEmptyLine(preview.data[j])) {
        emptyLinesCount++;
        continue;
      }
      const fieldCount = preview.data[j].length;
      avgFieldCount += fieldCount;

      if (typeof fieldCountPrevRow === 'undefined') {
        fieldCountPrevRow = fieldCount;
        continue;
      } else if (fieldCount > 1) {
        delta += Math.abs(fieldCount - fieldCountPrevRow);
        fieldCountPrevRow = fieldCount;
      }
    }

    if (preview.data.length > 0) {
      avgFieldCount /= preview.data.length - emptyLinesCount;
    }

    if ((typeof bestDelta === 'undefined' || delta < bestDelta) && avgFieldCount > 1.99) {
      bestDelta = delta;
      bestDelim = delim;
    }
  }

  return {
    successful: !!bestDelim,
    bestDelimiter: bestDelim,
  };
}

/** https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function testEmptyLine(s) {
  return s.length === 1 && s[0].length === 0;
  // return skipEmptyLines === 'greedy'
  //   ? s.join('').trim() === ''
  //   : s.length === 1 && s[0].length === 0;
}

function guessLineEndings(input, quoteChar) {
  input = input.substr(0, 1024 * 1024); // max length 1 MB
  // Replace all the text inside quotes
  const re = new RegExp(escapeRegExp(quoteChar) + '([^]*?)' + escapeRegExp(quoteChar), 'gm');
  input = input.replace(re, '');

  const r = input.split('\r');

  const n = input.split('\n');

  const nAppearsFirst = n.length > 1 && n[0].length < r[0].length;

  if (r.length === 1 || nAppearsFirst) {
    return '\n';
  }

  let numWithN = 0;
  for (let i = 0; i < r.length; i++) {
    if (r[i][0] === '\n') {
      numWithN++;
    }
  }

  return numWithN >= r.length / 2 ? '\r\n' : '\r';
}

function bindFunction(f, self) {
  return function() {
    f.apply(self, arguments);
  };
}

function isFunction(func) {
  return typeof func === 'function';
}

/**
 * Makes a deep copy of an array or object (mostly)
 */
function copy(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }
  const cpy = Array.isArray(obj) ? [] : {};
  for (const key in obj) {
    cpy[key] = copy(obj[key]);
  }
  return cpy;
}

function processResults(results, config) {
  // if (results && _delimiterError) {
  //   addError(
  //     'Delimiter',
  //     'UndetectableDelimiter',
  //     "Unable to auto-detect delimiting character; defaulted to '" + Papa.DefaultDelimiter + "'",
  //   );
  //   _delimiterError = false;
  // }

  if (config.skipEmptyLines) {
    for (let i = 0; i < results.data.length; i++) {
      if (testEmptyLine(results.data[i])) {
        results.data.splice(i--, 1);
      }
    }
  }

  if (needsHeaderRow(config)) {
    results = fillHeaderFields(results, config);
  }

  return applyHeaderAndDynamicTypingAndTransformation(results, config);
}

function shouldApplyDynamicTyping(field, config) {
  // Cache function values to avoid calling it for each row
  if (config.dynamicTypingFunction && config.dynamicTyping[field] === undefined) {
    config.dynamicTyping[field] = config.dynamicTypingFunction(field);
  }
  return (config.dynamicTyping[field] || config.dynamicTyping) === true;
}

function parseDynamic(field, value, config) {
  if (shouldApplyDynamicTyping(field, config)) {
    if (value === 'true' || value === 'TRUE') {
      return true;
    } else if (value === 'false' || value === 'FALSE') {
      return false;
    } else if (FLOAT.test(value)) {
      return parseFloat(value);
    } else if (ISO_DATE.test(value)) {
      return new Date(value);
    } else {
      return value === '' ? null : value;
    }
  }
  return value;
}

function applyHeaderAndDynamicTypingAndTransformation(results, config) {
  if (!results || (!config.header && !config.dynamicTyping && !config.transform)) {
    return results;
  }

  for (let i = 0; i < results.data.length; i++) {
    const row = config.header ? {} : [];

    let j;
    for (j = 0; j < results.data[i].length; j++) {
      let field = j;
      let value = results.data[i][j];

      if (config.header) {
        field = j >= fields.length ? '__parsed_extra' : fields[j];
      }

      if (config.transform) {
        value = config.transform(value, field);
      }

      value = parseDynamic(field, value, config);

      if (field === '__parsed_extra') {
        row[field] = row[field] || [];
        row[field].push(value);
      } else {
        row[field] = value;
      }
    }

    results.data[i] = row;

    // if (config.header) {
    //   if (j > fields.length) {
    //     addError(
    //       'FieldMismatch',
    //       'TooManyFields',
    //       'Too many fields: expected ' + fields.length + ' fields but parsed ' + j,
    //       _rowCounter + i,
    //     );
    //   } else if (j < fields.length) {
    //     addError(
    //       'FieldMismatch',
    //       'TooFewFields',
    //       'Too few fields: expected ' + fields.length + ' fields but parsed ' + j,
    //       _rowCounter + i,
    //     );
    //   }
    // }
    return results;
  }

  if (config.header && results.meta) {
    results.meta.fields = fields;
  }

  _rowCounter += results.data.length;
  return results;
}

function start(input, results, config, baseIndex?, ignoreLastRow?) {
  const quoteChar = config.quoteChar || '"';
  if (!config.newline) {
    config.newline = guessLineEndings(input, quoteChar);
  }

  let _delimiterError = false;
  let _paused;
  if (!config.delimiter) {
    const delimGuess = guessDelimiter(
      input,
      results,
      config.newline,
      config.skipEmptyLines,
      config.comments,
    );
    console.log(delimGuess);
    if (delimGuess.successful) {
      config.delimiter = delimGuess.bestDelimiter;
    } else {
      _delimiterError = true; // Add error after parsing (otherwise it would be overwritten)
      config.delimiter = DEFAULT_DELIMITER;
    }
    results.meta.delimiter = config.delimiter;
  } else if (isFunction(config.delimiter)) {
    config.delimiter = config.delimiter(input);
    results.meta.delimiter = config.delimiter;
  }

  const parserConfig = copy(config);
  if (config.preview && config.header) {
    parserConfig.preview++;
  } // To compensate for header row

  results = parse(input, results, config, baseIndex, ignoreLastRow);
  results = processResults(results, config);
  return results;
}

function parse(input, results, config: any = {}, baseIndex?, ignoreLastRow?) {
  // Unpack the config object
  let delim = config.delimiter;
  let newline = config.newline;
  let comments = config.comments;
  const step = config.step;
  const preview = config.preview;
  const fastMode = config.fastMode;
  let quoteChar;
  /** Allows for no quoteChar by setting quoteChar to undefined in config */
  if (config.quoteChar === undefined) {
    quoteChar = '"';
  } else {
    quoteChar = config.quoteChar;
  }
  let escapeChar = quoteChar;
  if (config.escapeChar !== undefined) {
    escapeChar = config.escapeChar;
  }

  // Delimiter must be valid
  if (typeof delim !== 'string' || BAD_DELIMITERS.indexOf(delim) > -1) {
    delim = ',';
  }

  // Comment character must be valid
  if (comments === delim) {
    throw new Error('Comment character same as delimiter');
  } else if (comments === true) {
    comments = '#';
  } else if (typeof comments !== 'string' || BAD_DELIMITERS.indexOf(comments) > -1) {
    comments = false;
  }

  // Newline must be valid: \r, \n, or \r\n
  if (newline !== '\n' && newline !== '\r' && newline !== '\r\n') {
    newline = '\n';
  }

  // We're gonna need these at the Parser scope
  let cursor = 0;
  const aborted = false;

  // For some reason, in Chrome, this speeds things up (!?)
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }

  // We don't need to compute some of these every time parse() is called,
  // but having them in a more local scope seems to perform better
  const inputLen = input.length;
  const delimLen = delim.length;
  const newlineLen = newline.length;
  const commentsLen = comments.length;
  const stepIsFunction = isFunction(step);

  // Establish starting state
  cursor = 0;
  let data = [];
  let errors = [];
  let row: any = [];
  let lastCursor = 0;

  if (!input) {
    return returnable();
  }

  if (fastMode || (fastMode !== false && input.indexOf(quoteChar) === -1)) {
    const rows = input.split(newline);
    for (let i = 0; i < rows.length; i++) {
      row = rows[i];
      cursor += row.length;
      if (i !== rows.length - 1) {
        cursor += newline.length;
      } else if (ignoreLastRow) {
        return returnable();
      }
      if (comments && row.substr(0, commentsLen) === comments) {
        continue;
      }
      if (stepIsFunction) {
        data = [];
        pushRow(row.split(delim));
        doStep();
        if (aborted) {
          return returnable();
        }
      } else {
        pushRow(row.split(delim));
      }
      if (preview && i >= preview) {
        data = data.slice(0, preview);
        return returnable(true);
      }
    }
    return returnable();
  }

  let nextDelim = input.indexOf(delim, cursor);
  let nextNewline = input.indexOf(newline, cursor);
  const quoteCharRegex = new RegExp(
    escapeChar.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&') + quoteChar,
    'g',
  );
  let quoteSearch;

  // Parser loop
  while (true) {
    // Field has opening quote
    if (input[cursor] === quoteChar) {
      // Start our search for the closing quote where the cursor is
      quoteSearch = cursor;

      // Skip the opening quote
      cursor++;

      while (true) {
        // Find closing quote
        quoteSearch = input.indexOf(quoteChar, quoteSearch + 1);

        //No other quotes are found - no other delimiters
        if (quoteSearch === -1) {
          if (!ignoreLastRow) {
            // No closing quote... what a pity
            errors.push({
              type: 'Quotes',
              code: 'MissingQuotes',
              message: 'Quoted field unterminated',
              row: data.length, // row has yet to be inserted
              index: cursor,
            });
          }
          return finish();
        }

        // Closing quote at EOF
        if (quoteSearch === inputLen - 1) {
          const value = input.substring(cursor, quoteSearch).replace(quoteCharRegex, quoteChar);
          return finish(value);
        }

        // If this quote is escaped, it's part of the data; skip it
        // If the quote character is the escape character, then check if the next character is the escape character
        if (quoteChar === escapeChar && input[quoteSearch + 1] === escapeChar) {
          quoteSearch++;
          continue;
        }

        // If the quote character is not the escape character, then check if the previous character was the escape character
        if (
          quoteChar !== escapeChar &&
          quoteSearch !== 0 &&
          input[quoteSearch - 1] === escapeChar
        ) {
          continue;
        }

        // Check up to nextDelim or nextNewline, whichever is closest
        const checkUpTo = nextNewline === -1 ? nextDelim : Math.min(nextDelim, nextNewline);
        const spacesBetweenQuoteAndDelimiter = extraSpaces(checkUpTo);

        // Closing quote followed by delimiter or 'unnecessary spaces + delimiter'
        if (input[quoteSearch + 1 + spacesBetweenQuoteAndDelimiter] === delim) {
          row.push(input.substring(cursor, quoteSearch).replace(quoteCharRegex, quoteChar));
          cursor = quoteSearch + 1 + spacesBetweenQuoteAndDelimiter + delimLen;
          nextDelim = input.indexOf(delim, cursor);
          nextNewline = input.indexOf(newline, cursor);
          break;
        }

        const spacesBetweenQuoteAndNewLine = extraSpaces(nextNewline);

        // Closing quote followed by newline or 'unnecessary spaces + newLine'
        if (input.substr(quoteSearch + 1 + spacesBetweenQuoteAndNewLine, newlineLen) === newline) {
          row.push(input.substring(cursor, quoteSearch).replace(quoteCharRegex, quoteChar));
          saveRow(quoteSearch + 1 + spacesBetweenQuoteAndNewLine + newlineLen);
          nextDelim = input.indexOf(delim, cursor); // because we may have skipped the nextDelim in the quoted field

          if (stepIsFunction) {
            doStep();
            if (aborted) {
              return returnable();
            }
          }

          if (preview && data.length >= preview) {
            return returnable(true);
          }

          break;
        }

        // Checks for valid closing quotes are complete (escaped quotes or quote followed by EOF/delimiter/newline) -- assume these quotes are part of an invalid text string
        errors.push({
          type: 'Quotes',
          code: 'InvalidQuotes',
          message: 'Trailing quote on quoted field is malformed',
          row: data.length, // row has yet to be inserted
          index: cursor,
        });

        quoteSearch++;
        continue;
      }

      continue;
    }

    // Comment found at start of new line
    if (comments && row.length === 0 && input.substr(cursor, commentsLen) === comments) {
      if (nextNewline === -1) {
        // Comment ends at EOF
        return returnable();
      }
      cursor = nextNewline + newlineLen;
      nextNewline = input.indexOf(newline, cursor);
      nextDelim = input.indexOf(delim, cursor);
      continue;
    }

    // Next delimiter comes before next newline, so we've reached end of field
    if (nextDelim !== -1 && (nextDelim < nextNewline || nextNewline === -1)) {
      row.push(input.substring(cursor, nextDelim));
      cursor = nextDelim + delimLen;
      nextDelim = input.indexOf(delim, cursor);
      continue;
    }

    // End of row
    if (nextNewline !== -1) {
      row.push(input.substring(cursor, nextNewline));
      saveRow(nextNewline + newlineLen);

      if (stepIsFunction) {
        doStep();
        if (aborted) {
          return returnable();
        }
      }

      if (preview && data.length >= preview) {
        return returnable(true);
      }

      continue;
    }

    break;
  }

  return finish();

  function pushRow(row) {
    data.push(row);
    lastCursor = cursor;
  }

  /**
   * checks if there are extra spaces after closing quote and given index without any text
   * if Yes, returns the number of spaces
   */
  function extraSpaces(index) {
    let spaceLength = 0;
    if (index !== -1) {
      const textBetweenClosingQuoteAndIndex = input.substring(quoteSearch + 1, index);
      if (textBetweenClosingQuoteAndIndex && textBetweenClosingQuoteAndIndex.trim() === '') {
        spaceLength = textBetweenClosingQuoteAndIndex.length;
      }
    }
    return spaceLength;
  }

  /**
   * Appends the remaining input from cursor to the end into
   * row, saves the row, calls step, and returns the results.
   */
  function finish(value?) {
    if (ignoreLastRow) {
      return returnable();
    }
    if (typeof value === 'undefined') {
      value = input.substr(cursor);
    }
    row.push(value);
    cursor = inputLen; // important in case parsing is paused
    pushRow(row);
    if (stepIsFunction) {
      doStep();
    }
    return returnable();
  }

  /**
   * Appends the current row to the results. It sets the cursor
   * to newCursor and finds the nextNewline. The caller should
   * take care to execute user's step function and check for
   * preview and end parsing if necessary.
   */
  function saveRow(newCursor) {
    cursor = newCursor;
    pushRow(row);
    row = [];
    nextNewline = input.indexOf(newline, cursor);
  }

  /** Returns an object with the results, errors, and meta. */
  function returnable(stopped?) {
    return {
      data,
      errors,
      meta: {
        delimiter: delim,
        linebreak: newline,
        aborted,
        truncated: !!stopped,
        cursor: lastCursor + (baseIndex || 0),
      },
    };
  }

  /** Executes the user's step function and resets data & errors. */
  function doStep() {
    step(returnable());
    data = [];
    errors = [];
  }
}

import fs from 'fs';
const longSampleRawCsv = fs.readFileSync(__dirname + '/sample.csv', 'utf8');
console.log(
  start(
    longSampleRawCsv,
    {
      data: [],
      errors: [],
      meta: {},
    },
    {},
  ),
);
