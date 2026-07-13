import "@testing-library/jest-dom";

// jsdom does not implement scrollIntoView — stub it so components that call
// it (e.g. auto-scroll-to-bottom) don't throw in test environments.
Element.prototype.scrollIntoView = () => {};
