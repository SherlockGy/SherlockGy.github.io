// Always replace the state as well as the text, so an earlier success cannot
// color a later error and normal progress never looks like a failure.
export function setFeedback(element, message, kind = 'info') {
  element.className = `upload-status${kind === 'info' ? '' : ` ${kind}`}`;
  element.textContent = message;
  element.scrollTop = 0;
}
