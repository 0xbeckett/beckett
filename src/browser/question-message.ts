/** Fixed marker carried by every atomic screenshot-backed browser question. */
export const BROWSER_QUESTION_SUFFIX =
  "\nReply directly to this message and I'll continue from the same page.";
export const BROWSER_QUESTION_ATTACHMENT_NAME = "beckett-browser-question.png";

export function isBrowserQuestionMessage(content: string, attachmentNames: Iterable<string>): boolean {
  return content.endsWith(BROWSER_QUESTION_SUFFIX)
    && [...attachmentNames].includes(BROWSER_QUESTION_ATTACHMENT_NAME);
}
