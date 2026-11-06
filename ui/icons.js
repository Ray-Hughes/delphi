// The window's line icons, drawn from data rather than markup.
//
// The same set the v2 mockup is drawn with: 24 by 24, stroked, round caps, so
// every icon sits on one grid and takes the colour of its text. Each is a list
// of [tag, attributes] built with createElementNS, because the renderer never
// assigns innerHTML and an SVG string would need it.

globalThis.DelphiIcons = (() => {
  const SVG = "http://www.w3.org/2000/svg";
  const SHAPES = {
    search: [["circle",{"cx":"11","cy":"11","r":"7"}],["path",{"d":"m20 20-3.5-3.5"}]],
    plus: [["path",{"d":"M12 5v14M5 12h14"}]],
    x: [["path",{"d":"M18 6 6 18M6 6l12 12"}]],
    down: [["path",{"d":"m6 9 6 6 6-6"}]],
    right: [["path",{"d":"m9 6 6 6-6 6"}]],
    folder: [["path",{"d":"M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"}]],
    folderplus: [["path",{"d":"M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"}],["path",{"d":"M12 10.5v6M9 13.5h6"}]],
    branch: [["circle",{"cx":"6","cy":"5.5","r":"2"}],["circle",{"cx":"6","cy":"18.5","r":"2"}],["circle",{"cx":"18","cy":"7.5","r":"2"}],["path",{"d":"M6 7.5v9M18 9.5c0 4-4 4.5-10.5 7.5"}]],
    today: [["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"}]],
    tasks: [["rect",{"x":"3.5","y":"3.5","width":"17","height":"17","rx":"4"}],["path",{"d":"m8.5 12 2.5 2.5 4.5-5"}]],
    memory: [["path",{"d":"M2.5 5.5h6a3.5 3.5 0 0 1 3.5 3.5v10.5a2.5 2.5 0 0 0-2.5-2.5h-7zM21.5 5.5h-6A3.5 3.5 0 0 0 12 9v10.5a2.5 2.5 0 0 1 2.5-2.5h7z"}]],
    pad: [["path",{"d":"M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9z"}],["path",{"d":"M14 3v6h6M8 13h8M8 17h5"}]],
    runs: [["rect",{"x":"3","y":"4","width":"18","height":"16","rx":"3"}],["path",{"d":"m7.5 9.5 3 2.5-3 2.5M13 15h3.5"}]],
    inbox: [["path",{"d":"M21.5 12.5h-5.5l-2 3h-4l-2-3H2.5"}],["path",{"d":"M5.5 5h13l3 7.5v5A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5v-5z"}]],
    gear: [["circle",{"cx":"12","cy":"12","r":"3"}],["path",{"d":"M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"}]],
    focus: [["circle",{"cx":"12","cy":"12","r":"8.5"}],["circle",{"cx":"12","cy":"12","r":"4"}],["circle",{"cx":"12","cy":"12","r":".6","fill":"currentColor"}]],
    check: [["path",{"d":"m5 12.5 4.5 4.5L19 7"}]],
    sparkle: [["path",{"d":"M12 3.5 13.8 9 19.5 10.8 13.8 12.6 12 18.5 10.2 12.6 4.5 10.8 10.2 9z"}],["path",{"d":"M19 3v3M17.5 4.5h3"}]],
    moon: [["path",{"d":"M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"}]],
    sun: [["circle",{"cx":"12","cy":"12","r":"4"}],["path",{"d":"M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"}]],
    more: [["circle",{"cx":"5.5","cy":"12","r":"1.2","fill":"currentColor","stroke":"none"}],["circle",{"cx":"12","cy":"12","r":"1.2","fill":"currentColor","stroke":"none"}],["circle",{"cx":"18.5","cy":"12","r":"1.2","fill":"currentColor","stroke":"none"}]],
    chat: [["path",{"d":"M20.5 12a8 8 0 0 1-11.8 7L3.5 20.5 5 15.6A8 8 0 1 1 20.5 12z"}]],
    link: [["path",{"d":"M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"}]],
    archive: [["rect",{"x":"3","y":"4","width":"18","height":"5","rx":"1.5"}],["path",{"d":"M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"}]],
    pin: [["path",{"d":"M12 16.5V21M8.5 3.5h7l-1 5.5 3.5 3.5V14H6v-1.5L9.5 9z"}]],
    eye: [["path",{"d":"M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"}],["circle",{"cx":"12","cy":"12","r":"2.5"}]],
    alert: [["path",{"d":"M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"}],["path",{"d":"M12 9.5v4M12 17h.01"}]],
    clock: [["circle",{"cx":"12","cy":"12","r":"8.5"}],["path",{"d":"M12 7.5V12l3 2"}]],
    pencil: [["path",{"d":"M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"}],["path",{"d":"m13.5 6.5 4 4"}]],
    sliders: [["path",{"d":"M4 7h10M18 7h2M4 17h4M12 17h8"}],["circle",{"cx":"16","cy":"7","r":"2"}],["circle",{"cx":"10","cy":"17","r":"2"}]],
    list: [["path",{"d":"M9 6h11M9 12h11M9 18h11"}],["circle",{"cx":"4.5","cy":"6","r":".6","fill":"currentColor"}],["circle",{"cx":"4.5","cy":"12","r":".6","fill":"currentColor"}],["circle",{"cx":"4.5","cy":"18","r":".6","fill":"currentColor"}]],
    // Focus mode's: Interruption, Break, a parked task, and Send.
    bolt: [["path",{"d":"M13 2 4 14h7l-1 8 9-12h-7z"}]],
    cup: [["path",{"d":"M5 9h11v5a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5z"}],["path",{"d":"M16 10h1.5a2.5 2.5 0 0 1 0 5H16"}],["path",{"d":"M8 3v2M12 3v2"}]],
    pause: [["path",{"d":"M9 6v12M15 6v12"}]],
    send: [["path",{"d":"M12 19V5M5 12l7-7 7 7"}]],
    kanban: [["rect",{"x":"3.5","y":"4","width":"5","height":"15","rx":"1.5"}],["rect",{"x":"10.5","y":"4","width":"5","height":"10","rx":"1.5"}],["rect",{"x":"17.5","y":"4","width":"3","height":"6","rx":"1"}]],
  };

  /** One icon as an <svg>, or an empty span for a name that is not here. */
  function icon(name, size = "") {
    const shapes = SHAPES[name];
    if (!shapes) return document.createElement("span");
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", `i${size ? ` ${size}` : ""}`);
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attrs] of shapes) {
      const node = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
      svg.append(node);
    }
    return svg;
  }

  return { icon, names: () => Object.keys(SHAPES) };
})();
