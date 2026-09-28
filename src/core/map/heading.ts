/** Relative changes in a continuous sensor heading; never a ground-track replacement. */
export type HeadingSample = { degrees: number; time: number; frame: number };
export type HeadingListener = (sample: HeadingSample | null) => void;
/** Acquisition may request browser sensor permission; call from the orientation gesture. */
export type HeadingSource = { acquireHeading(listener: HeadingListener): () => void };
