const RECORD_SEP = String.fromCharCode(30);
const UNIT_SEP = String.fromCharCode(31);
const DEFAULT_DELIMITER = ',';
const FLOAT = /^\s*-?(\d*\.?\d+|\d+\.?\d*)(e[-+]?\d+)?\s*$/i;
const ISO_DATE = /(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d\.\d+([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))|(\d{4}-[01]\d-[0-3]\dT[0-2]\d:[0-5]\d([+-][0-2]\d:[0-5]\d|Z))/;
const BYTE_ORDER_MARK = '\ufeff';
const BAD_DELIMITERS = ['\r', '\n', '"', BYTE_ORDER_MARK];

function needsHeaderRow(config: Config, fields) {
  return config.header && fields.length === 0;
}

function fillHeaderFields(results, config: Config) {
  if (!results) {
    return;
  }
  for (let i = 0; needsHeaderRow(config, results.fields) && i < results.data.length; i++) {
    for (let header of results.data[i]) {
      if (config.trimHeaders) {
        header = header.trim();
      }

      results.fields.push(header);
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

  for (const delim of delimChoices) {
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

    for (const line of preview.data) {
      if (skipEmptyLines && testEmptyLine(line, skipEmptyLines)) {
        emptyLinesCount++;
        continue;
      }
      const fieldCount = line.length;
      avgFieldCount += fieldCount;

      if (fieldCountPrevRow === undefined) {
        fieldCountPrevRow = fieldCount;
        continue;
      }
      if (fieldCount > 1) {
        delta += Math.abs(fieldCount - fieldCountPrevRow);
        fieldCountPrevRow = fieldCount;
      }
    }

    if (preview.data.length > 0) {
      avgFieldCount /= preview.data.length - emptyLinesCount;
    }

    if ((bestDelta === undefined || delta < bestDelta) && avgFieldCount > 1.99) {
      bestDelta = delta;
      bestDelim = delim;
    }
  }

  return {
    successful: !!bestDelim,
    bestDelimiter: bestDelim,
  };
}

/**
 * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_Expressions
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function testEmptyLine(s, skipEmptyLines: Config['skipEmptyLines']) {
  return skipEmptyLines === 'greedy'
    ? s.join('').trim() === ''
    : s.length === 1 && s[0].length === 0;
}

function guessLineEndings(input: string, quoteChar) {
  let inputPiece = input.substr(0, 1024 * 1024); // max length 1 MB
  // Replace all the text inside quotes
  const re = new RegExp(`${escapeRegExp(quoteChar)}([^]*?)${escapeRegExp(quoteChar)}`, 'gm');
  inputPiece = inputPiece.replace(re, '');

  const r = inputPiece.split('\r');
  const n = inputPiece.split('\n');

  const nAppearsFirst = n.length > 1 && n[0].length < r[0].length;

  if (r.length === 1 || nAppearsFirst) {
    return '\n';
  }

  let numWithN = 0;
  for (const g of r) {
    if (g[0] === '\n') {
      numWithN++;
    }
  }

  return numWithN >= r.length / 2 ? '\r\n' : '\r';
}

function addError(results, type, code, msg, row?) {
  results.errors.push({
    type,
    code,
    message: msg,
    row,
  });
}

function processResults(results, config) {
  let res = results;
  if (results && results.delimiterError) {
    addError(
      results,
      'Delimiter',
      'UndetectableDelimiter',
      `Unable to auto-detect delimiting character; defaulted to '${DEFAULT_DELIMITER}'`,
    );
    results.delimiterError = false;
  }

  if (config.skipEmptyLines) {
    for (let i = 0; i < res.data.length; i++) {
      if (testEmptyLine(res.data[i], config.skipEmptyLines)) {
        results.data.splice(i--, 1);
      }
    }
  }

  if (needsHeaderRow(config, res.fields)) {
    res = fillHeaderFields(res, config);
  }

  return applyHeaderAndDynamicTypingAndTransformation(res, config);
}

function shouldApplyDynamicTyping(field, config) {
  // Cache function values to avoid calling it for each row
  if (config.dynamicTypingFunction && config.dynamicTyping[field] === undefined) {
    config.dynamicTyping[field] = config.dynamicTypingFunction(field);
  }
  return ((config.dynamicTyping && config.dynamicTyping[field]) || config.dynamicTyping) === true;
}

function parseDynamic(field, value, config: Config) {
  if (shouldApplyDynamicTyping(field, config)) {
    if (value === 'true' || value === 'TRUE') {
      return true;
    }
    if (value === 'false' || value === 'FALSE') {
      return false;
    }
    if (FLOAT.test(value)) {
      return parseFloat(value);
    }
    if (ISO_DATE.test(value)) {
      return new Date(value);
    }
    return value === '' ? null : value;
  }
  return value;
}

function applyHeaderAndDynamicTypingAndTransformation(results, config) {
  if (!results || (!config.header && !config.dynamicTyping && !config.transform)) {
    return results;
  }

  for (let i = 0; i < results.data.length; i++) {
    const row: any | any[] = config.header ? {} : [];

    let j = 0;
    for (; j < results.data[i].length; j++) {
      let field = j;
      let parsedExtra = false;
      let value = results.data[i][j];

      if (config.header) {
        field = results.fields[j];
      }

      if (config.transform) {
        value = config.transform(value, field);
        parsedExtra = j >= results.fields.length;
      }

      value = parseDynamic(field, value, config);

      if (parsedExtra) {
        row.__parsed_extra = row.__parsed_extra || [];
        row.__parsed_extra.push(value);
      } else {
        row[field] = value;
      }
    }
    results.data[i] = row;

    if (config.header && j === results.fields.length) {
      continue;
    }
    if (j > results.fields.length) {
      addError(
        'FieldMismatch',
        'TooManyFields',
        `Too many fields: expected ${results.fields.length} fields but parsed ${j}`,
        results.rowCounter + i,
      );
    } else if (j < results.fields.length) {
      addError(
        'FieldMismatch',
        'TooFewFields',
        `Too few fields: expected ${results.fields.length} fields but parsed ${j}`,
        results.rowCounter + i,
      );
    }
  }

  if (config.header && results.meta) {
    results.meta.fields = results.fields;
  }

  results.rowCounter += results.data.length;
  return results;
}

export function start(input, config: Partial<Config> = {}, baseIndex?, ignoreLastRow?) {
  let results = {
    data: [],
    errors: [],
    meta: {} as any,
    fields: [],
    rowCounter: 0,
    delimiterError: false,
  };
  const quoteChar = config.quoteChar || '"';
  if (!config.newline) {
    config.newline = guessLineEndings(input, quoteChar);
  }

  // let _paused;
  if (!config.delimiter) {
    const delimGuess = guessDelimiter(
      input,
      results,
      config.newline,
      config.skipEmptyLines,
      config.comments,
    );
    if (delimGuess.successful) {
      config.delimiter = delimGuess.bestDelimiter;
    } else {
      results.delimiterError = true; // Add error after parsing (otherwise it would be overwritten)
      config.delimiter = DEFAULT_DELIMITER;
    }
    results.meta.delimiter = config.delimiter;
  } else if (typeof config.delimiter === 'function') {
    config.delimiter = config.delimiter(input);
    results.meta.delimiter = config.delimiter;
  }

  const parserConfig = { ...config };
  if (config.preview && config.header) {
    parserConfig.preview++;
  } // To compensate for header row

  results = parse(input, results, config, baseIndex, ignoreLastRow);
  results = processResults(results, config);
  return results;
}

type delimParse = (x: string) => string;

export interface Config {
  /**
   * The delimiting character. Leave blank to auto-detect from a list of most common delimiters.
   * It can be a string or a function. If string, it must be one of length 1. If a function, it
   * must accept the input as first parameter and it must return a string which will be used as
   * delimiter. In both cases it cannot be found in BAD_DELIMITERS.
   *
   * `default: ""`
   */
  delimiter: string | delimParse;
  /**
   * The newline sequence. Leave blank to auto-detect. Must be one of \r, \n, or \r\n.
   *
   * `default: ""`
   */
  newline: string;
  /**
   * The character used to quote fields. The quoting of all fields is not mandatory.
   * Any field which is not quoted will correctly read.
   *
   * `default: '"'`
   */
  quoteChar: string;
  /**
   * The character used to escape the quote character within a field. If not set, this option will
   * default to the value of quoteChar, meaning that the default escaping of quote character within
   * a quoted field is using the quote character two times. (e.g. "column with ""quotes"" in text")
   *
   * `default: '"'`
   */
  escapeChar: string;
  /**
   * If true, the first row of parsed data will be interpreted as field names. An array of field names
   * will be returned in meta, and each row of data will be an object of values keyed by field name
   * instead of a simple array. Rows with a different number of fields from the header row will produce
   * an error. **Warning**: Duplicate field names will overwrite values in previous fields having the same name.
   *
   * `default: false`
   */
  header: boolean;
  /**
   * A function to apply on each header. Requires header to be true. The function receives the header as its first argument.
   *
   * `default: undefined`
   */
  transformHeader: undefined;
  /**
   * If true, numeric and boolean data will be converted to their type instead of remaining strings.
   * Numeric data must conform to the definition of a decimal literal. European-formatted numbers must
   * have commas and dots swapped. If also accepts an object or a function. If object it's values should
   * be a boolean to indicate if dynamic typing should be applied for each column number (or header name
   * if using headers). If it's a function, it should return a boolean value for each field number
   * (or name if using headers) which will be passed as first argument.
   *
   * `default: false`
   */
  dynamicTyping: boolean;
  /**
   * If > 0, only that many rows will be parsed.
   *
   * `default: 0`
   */
  preview: number;
  /**
   * The encoding to use when opening local files. If specified, it must be a value supported by
   * the FileReader API.
   *
   * `default: ''`
   */
  encoding: string;
  /**
   * Whether or not to use a worker thread. Using a worker will keep your page reactive, but
   * may be slightly slower. Web Workers also load the entire Javascript file, so be careful
   * when combining other libraries in the same file as Papa Parse. Note that worker option
   * is only available when parsing files and not when converting from JSON to CSV.
   *
   * `default: false`
   */
  worker: boolean;
  /**
   * A string that indicates a comment (for example, "#" or "//"). When Papa encounters a
   * line starting with this string, it will skip the line.
   *
   * `default: false`
   */
  comments: boolean | string;

  /**
   * To stream the input, define a callback function:
   * Streaming is necessary for large files which would otherwise crash the browser.
   * You can call parser.abort() to abort parsing. And, except when using a Web Worker,
   * you can call parser.pause() to pause it, and parser.resume() to resume.
   *
   * `default: undefined`
   */
  step: (results, parser?) => any;
  /**
   * The callback to execute when parsing is complete. It receives the parse results.
   * If parsing a local file, the File is passed in, too:
   * When streaming, parse results are not available in this callback.
   */
  complete: (results, file) => any;
  /**
   * 	A callback to execute if FileReader encounters an error. The function is passed
   * two arguments: the error and the File.
   *
   * `default: undefined`
   */
  error: void;
  /**
   * If true, this indicates that the string you passed as the first argument to parse()
   * is actually a URL from which to download a file and parse its contents.
   *
   * `default: false`
   */
  download: boolean;
  /**
   * If true, lines that are completely empty (those which evaluate to an empty string)
   * will be skipped. If set to 'greedy', lines that don't have any content (those which
   * have only whitespace after parsing) will also be skipped.
   *
   * `default: false`
   */
  skipEmptyLines: false | 'greedy';
  /**
   * 	A callback function, identical to step, which activates streaming. However, this
   * function is executed after every chunk of the file is loaded and parsed rather than
   * every row. Works only with local and remote files. Do not use both chunk and
   * step callbacks together. For the function signature, see the documentation for
   * the step function.
   *
   * `default: undefined`
   */
  chunk: void;
  /**
   * Fast mode speeds up parsing significantly for large inputs. However, it only works when
   * the input has no quoted fields. Fast mode will automatically be enabled if no " characters
   * appear in the input. You can force fast mode either way by setting it to true or false.
   *
   * `default: false`
   */
  fastMode: boolean;
  /**
   * A function to execute before parsing the first chunk. Can be used with chunk or step
   * streaming modes. The function receives as an argument the chunk about to be parsed,
   * and it may return a modified chunk to parse. This is useful for stripping header lines
   * (as long as the header fits in a single chunk).
   *
   * `default: undefined`
   */
  beforeFirstChunk: void;
  /**
   * A function to apply on each value. The function receives the value as its first argument
   * and the column number as its second argument. The return value of the function will replace
   * the value it received. The transform function is applied before dynamicTyping.
   */
  transform: void;
  /**
   *
   */
  trimHeaders: boolean;
}

function parse(input, results, config: Partial<Config> = {}, baseIndex?, ignoreLastRow?) {
  // Unpack the config object
  let delim = config.delimiter;
  let newline = config.newline;
  let comments = config.comments;
  const step = config.step;
  const preview = config.preview;
  const fastMode = config.fastMode;
  let quoteChar: string;

  /**
   * Allows for no quoteChar by setting quoteChar to undefined in config
   */
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
  }
  if (comments === true) {
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
  const commentsLen = typeof comments === 'string' ? comments.length : 0;

  // Establish starting state
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
      if (typeof step === 'function') {
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
  // tslint:disable-next-line:no-constant-condition
  while (true) {
    // Field has opening quote
    if (input[cursor] === quoteChar) {
      // Start our search for the closing quote where the cursor is
      quoteSearch = cursor;

      // Skip the opening quote
      cursor++;

      // tslint:disable-next-line:no-constant-condition
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

          if (typeof step === 'function') {
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

      if (typeof step === 'function') {
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

  function pushRow(r) {
    data.push(r);
    lastCursor = cursor;
  }

  /**
   * checks if there are extra spaces after closing quote and given index without any text
   * if Yes, returns the number of spaces
   */
  function extraSpaces(index: number) {
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
    let val = value;
    if (ignoreLastRow) {
      return returnable();
    }
    if (val === undefined) {
      val = input.substr(cursor);
    }
    row.push(val);
    cursor = inputLen; // important in case parsing is paused
    pushRow(row);
    if (typeof step === 'function') {
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

  /**
   * Returns an object with the results, errors, and meta.
   */
  function returnable(stopped?) {
    return {
      data,
      errors,
      fields: results.fields,
      rowCounter: results.rowCounter,
      delimiterError: results.delimiterError,
      meta: {
        delimiter: delim,
        linebreak: newline,
        aborted,
        truncated: !!stopped,
        cursor: lastCursor + (baseIndex || 0),
      },
    };
  }

  /**
   * Executes the user's step function and resets data & errors.
   */
  function doStep() {
    step(returnable());
    data = [];
    errors = [];
  }
}
