import parkWalk640 from "@/src/assets/album/intro.jpeg";
import parkWalk1280 from "@/src/assets/album/intro.jpeg";

const url640 = typeof parkWalk640 === "string" ? parkWalk640 : parkWalk640.src;
const url1280 = typeof parkWalk1280 === "string" ? parkWalk1280 : parkWalk1280.src;

export const albumLoginIllustration = Object.freeze({
  id: "park-walk",
  photo: Object.freeze({
    src: url640,
    srcSet: `${url640} 640w, ${url1280} 1280w`,
    width: 1280,
    height: 854,
  }),
  alt: "Una pareja camina de la mano por un sendero arbolado.",
});
