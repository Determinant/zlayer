// ZLayer browser host for pinned PX4 EKF2. Estimation equations live in vendor/.
#include "ekf.h"
#include "modules/sensors/Integrator.hpp"
#include "snapshot.h"
#include <cmath>
#include <new>

// The friend hook initializes priors, primes delayed history and exposes diagnostics.
// It never implements a second prediction/correction algorithm.
struct ZLayerPx4 {
    Ekf ekf;
    sensors::IntegratorConing gyro;
    sensors::Integrator accel;
    Vector3f bias{};
    Vector3f accel_bias{};
    float accel_bias_std{0.2f};
    float bias_std{0.1f};
    Quatf pose{};
    bool seeded_pose{false};
    bool started{false};
    unsigned warmup_remaining{0};
    unsigned heading_source{HeadingSource::UNKNOWN};
    double last{0};
    double result[Snapshot::SIZE]{};
    double covariance[State::size * State::size]{};

    ZLayerPx4() {
        auto &p = *ekf.getParamHandle();
        // Fixed 50 Hz target; downsampling retains actual browser intervals.
        p.ekf2_predict_us = 20000;
        p.ekf2_gps_delay = 0; // Acquisition timestamps are already in the IMU clock.
        p.ekf2_mag_delay = 0;
        p.ekf2_delay_max = 300; // Browser callback latency; output predictor remains current.
        p.ekf2_mag_type = MagFuseType::NONE;
        // Match the pinned flight-module defaults, which override common.h.
        p.ekf2_mag_check = static_cast<int>(MagCheckMask::STRENGTH);
        p.ekf2_acc_b_noise = .003f;
        p.ekf2_gyr_b_lim = .15f;
        p.ekf2_gps_v_noise = .3f;
        p.ekf2_wind_nsd = .05f;
        p.ekf2_gps_ctrl = static_cast<int>(GnssCtrl::HPOS) | static_cast<int>(GnssCtrl::VPOS) | static_cast<int>(GnssCtrl::VEL);
        p.ekf2_hgt_ref = static_cast<int>(HeightSensor::GNSS);
        // Browser lacks receiver fix type, satellite count, DOP and speed accuracy.
        p.ekf2_gps_check = 1 << 2; // GnssChecks::GnssChecksMask::kHacc (private enum).
        p.ekf2_req_eph = 25.6f; // 50 m browser 95% accuracy / 1.96.
        p.ekf2_req_sacc = 10.f; // Conservative assumed velocity noise also gates the GSF.
        ekf.init(1000000000);
        warmup_remaining = ekf._imu_buffer_length - 1;
        ekf.set_is_fixed_wing(true);
        // Unknown until the browser's GPS/IMU qualification supplies timed flags.
        ekf.set_vehicle_at_rest(false);
        ekf.set_in_air_status(true);
    }

    static uint64_t clock(double seconds) { return uint64_t(std::llround((seconds + 1000.) * 1e6)); }

    void seed_bias() {
        ekf._state.gyro_bias = bias;
        ekf.P.uncorrelateCovarianceSetVariance<3>(State::gyro_bias.idx, bias_std * bias_std);
        ekf._output_predictor._gyro_bias = bias;
    }

    void heading(double radians, double variance) {
        // An explicit heading seeds current output once. Carry the same yaw
        // change to the delayed state; do not gate it as another sensor sample.
        const float change = matrix::wrap_pi(float(radians) - getEulerYaw(ekf.getQuaternion()));
        ekf.resetQuatStateYaw(getEulerYaw(ekf._state.quat_nominal) + change, variance);
        ekf._control_status.flags.yaw_align = true;
        ekf._control_status.flags.yaw_manual = true;
        ekf._control_status.flags.mag_heading_consistent = false;
        heading_source = HeadingSource::MANUAL;
    }

    void initialize(double time, const Vector3f &rate, const Vector3f &force) {
        ekf._accel_lpf.reset(force);
        ekf._gyro_lpf.reset(rate);
        ekf._time_latest_us = ekf._time_delayed_us = clock(time);
        if (seeded_pose) {
            ekf._state.quat_nominal = pose;
            ekf._R_to_earth = Dcmf(pose);
            ekf.initialiseCovariance();
            ekf._filter_initialised = true;
        } else {
            ekf._filter_initialised = ekf.initialiseFilter();
        }
        if (!ekf._filter_initialised) { return; }
        seed_bias();
        ekf._state.accel_bias = accel_bias;
        ekf.P.uncorrelateCovarianceSetVariance<3>(State::accel_bias.idx, accel_bias_std * accel_bias_std);
        ekf._output_predictor._accel_bias = accel_bias;
        ekf._output_predictor.alignOutputFilter(ekf._state.quat_nominal, ekf._state.vel, ekf._gpos);
        started = true;
    }

    void imu(double time, Vector3f rate, Vector3f force) {
        if (!started) {
            initialize(time, rate, force);
            gyro.put(rate, 0); accel.put(force, 0); last = time;
            return;
        }
        const float dt = time - last;
        last = time;
        gyro.put(rate, dt); accel.put(force, dt);
        imuSample sample{};
        uint32_t angle_dt{}, velocity_dt{};
        if (!gyro.reset(sample.delta_ang, angle_dt) || !accel.reset(sample.delta_vel, velocity_dt)) { return; }
        sample.delta_ang_dt = angle_dt * 1e-6f;
        sample.delta_vel_dt = velocity_dt * 1e-6f;
        sample.time_us = clock(time);
        ekf.setIMUData(sample);
        if (!ekf._imu_updated) { return; }
        if (warmup_remaining) {
            // Fill matching IMU/output histories before delayed prediction.
            // The live predictor already integrated this genuine interval.
            auto &output = ekf._output_predictor;
            output._output_buffer.push(output._output_new);
            output._output_vert_buffer.push(output._output_vert_new);
            output._output_vert_new.dt = 0.f;
            ekf._imu_updated = false;
            --warmup_remaining;
            return;
        }
        const auto reset_count = ekf.get_quat_reset_count();
        // Consume this event per update, rather than using a latched past source.
        ekf._information_events.flags.yaw_aligned_to_imu_gps = false;
        ekf.update();
        if (ekf._information_events.flags.yaw_aligned_to_imu_gps) {
            heading_source = HeadingSource::GNSS;
        } else if (!ekf._control_status.flags.yaw_align || ekf.get_quat_reset_count() != reset_count) {
            heading_source = HeadingSource::UNKNOWN;
        }
        const auto &velocity = ekf.aid_src_gnss_vel();
        // Magnetic startup is still unverified north for the app. Once GNSS
        // agrees, use PX4's real yaw prior/reset, including its covariance, once.
        const bool gnss_heading_valid = ekf._control_status.flags.yaw_align && ekf._control_status.flags.gnss_vel
            && ekf._gnss_checks.passed() && velocity.fused && !velocity.innovation_rejected
            && ekf.isNewestSampleRecent(velocity.time_last_fuse, 2 * GNSS_MAX_INTERVAL)
            && ekf.isYawEmergencyEstimateAvailable() && !ekf.isYawFailure();
        if (gnss_heading_valid && heading_source == HeadingSource::UNKNOWN && ekf.resetYawToEKFGSF()) {
            heading_source = HeadingSource::GNSS;
        }
    }

    template <typename Report> void aid(const Report &a, unsigned offset, unsigned dimensions) {
        result[offset + Aid::TIME] = a.timestamp_sample ? double(a.timestamp_sample) * 1e-6 - 1000. : -INFINITY;
        result[offset + Aid::LAST_FUSION] = a.time_last_fuse ? double(a.time_last_fuse) * 1e-6 - 1000. : -INFINITY;
        result[offset + Aid::FUSED] = a.fused;
        result[offset + Aid::REJECTED] = a.innovation_rejected;
        for (unsigned i = 0; i < dimensions; ++i) {
            result[offset + Aid::INNOVATION + i] = a.innovation[i];
            result[offset + Aid::VARIANCE + i] = a.innovation_variance[i];
        }
    }

    double *snapshot() {
        using namespace Snapshot;
        auto q = ekf.getQuaternion();
        auto v = ekf.getVelocity();
        auto bg = ekf.getGyroBias();
        auto ba = ekf.getAccelBias();
        for (int i = 0; i < 4; ++i) { result[QUATERNION+i] = q(i); }
        for (int i = 0; i < 3; ++i) {
            result[VELOCITY+i] = v(i); result[GYRO_BIAS+i] = bg(i); result[ACCEL_BIAS+i] = ba(i);
            result[GYRO_BIAS_VARIANCE+i] = ekf.P(State::gyro_bias.idx+i, State::gyro_bias.idx+i);
            result[ACCEL_BIAS_VARIANCE+i] = ekf.P(State::accel_bias.idx+i, State::accel_bias.idx+i);
        }
        result[STARTED] = started;
        const auto &f = ekf._control_status.flags;
        result[YAW_ALIGNED] = f.yaw_align; result[GNSS_VELOCITY] = f.gnss_vel; result[GNSS_HEIGHT] = f.gps_hgt;
        result[GRAVITY] = f.gravity_vector; result[MAGNETIC_MODE] = f.mag_3D ? 2 : f.mag_hdg ? 1 : 0;
        result[HEADING_SOURCE] = heading_source;
        result[UNAIDED_YAW] = ekf.getUnaidedYaw();
        aid(ekf.aid_src_gravity(), GRAVITY_AID, 3);
        aid(ekf.aid_src_gnss_vel(), VELOCITY_AID, ekf._gps_sample_delayed.vertical_velocity_valid ? 3 : 2);
        aid(ekf.aid_src_mag(), MAGNETIC_AID, 3);
        const auto &h = ekf.aid_src_gnss_hgt();
        result[HEIGHT_AID + Aid::TIME] = h.timestamp_sample ? double(h.timestamp_sample)*1e-6-1000. : -INFINITY;
        result[HEIGHT_AID + Aid::LAST_FUSION] = h.time_last_fuse ? double(h.time_last_fuse)*1e-6-1000. : -INFINITY;
        result[HEIGHT_AID + Aid::FUSED] = h.fused; result[HEIGHT_AID + Aid::REJECTED] = h.innovation_rejected;
        result[HEIGHT_AID + Aid::INNOVATION] = h.innovation; result[HEIGHT_AID + Aid::VARIANCE] = h.innovation_variance;
        result[VELOCITY_DIMENSION] = !ekf._gps_sample_delayed.horizontal_velocity_valid ? 0 : ekf._gps_sample_delayed.vertical_velocity_valid ? 3 : 2;
        result[AT_REST] = f.vehicle_at_rest;
        result[IN_AIR] = f.in_air;
        result[DELAYED_TIME] = double(ekf._time_delayed_us) * 1e-6 - 1000.;
        for (unsigned r = 0; r < 3; ++r) {
            for (unsigned c = 0; c < 3; ++c) { result[ATTITUDE_COVARIANCE + 3*r + c] = ekf.P(r,c); }
        }
        result[HEIGHT_VALID] = ekf._gps_sample_delayed.height_valid;
        return result;
    }
};

extern "C" {
ZLayerPx4 *px4_create() { return new ZLayerPx4; }
void px4_destroy(ZLayerPx4 *p) { delete p; }
void px4_configure(ZLayerPx4 *p, int gps, int gravity, double gyro_noise, double accel_noise,
                   double gyro_walk, double accel_walk, double tilt_std, double accel_bias_std) {
    auto &c = *p->ekf.getParamHandle();
    if (!gps) { c.ekf2_gps_ctrl = 0; }
    if (gravity) { c.ekf2_imu_ctrl |= static_cast<int>(ImuCtrl::GravityVector); }
    c.ekf2_gyr_noise = gyro_noise; c.ekf2_acc_noise = accel_noise;
    c.ekf2_gyr_b_noise = gyro_walk; c.ekf2_acc_b_noise = accel_walk;
    c.ekf2_angerr_init = tilt_std; c.ekf2_abias_init = accel_bias_std;
    p->accel_bias_std = accel_bias_std;
    p->ekf.updateParameters();
}
void px4_seed(ZLayerPx4 *p, double x, double y, double z, double std, int pose,
              double qw, double qx, double qy, double qz) {
    p->bias = Vector3f(x,y,z); p->bias_std = std;
    p->seeded_pose = pose; p->pose = Quatf(qw,qx,qy,qz);
    if (p->started) {
        p->seed_bias();
    }
}
void px4_accel_bias(ZLayerPx4 *p, double x, double y, double z, double std) {
    p->accel_bias = Vector3f(x,y,z); p->accel_bias_std = std;
}
void px4_imu(ZLayerPx4 *p, double time, double gx, double gy, double gz, double ax, double ay, double az) {
    p->imu(time, Vector3f(gx,gy,gz), Vector3f(ax,ay,az));
}
void px4_gps(ZLayerPx4 *p, double time, double lat, double lon, double alt, double hacc, double vacc,
             double vn, double ve, double vd, double sacc, int horizontal, int vertical, int position, int height, int quality) {
    gnssSample g{};
    g.time_us = ZLayerPx4::clock(time); g.lat = lat; g.lon = lon; g.alt = alt;
    g.hacc = hacc; g.vacc = vacc; g.sacc = sacc; g.vel = Vector3f(vn,ve,vd);
    g.yaw = NAN; g.horizontal_velocity_valid = horizontal; g.vertical_velocity_valid = vertical;
    g.position_valid = position; g.height_valid = height;
    g.quality_valid = quality;
    p->ekf.setGpsData(g);
}
void px4_mag(ZLayerPx4 *p, double time, double x, double y, double z) {
    p->ekf.getParamHandle()->ekf2_mag_type = MagFuseType::AUTO;
    magSample m{}; m.time_us = ZLayerPx4::clock(time); m.mag = Vector3f(x,y,z) * 0.01f; // µT to gauss
    p->ekf.setMagData(m);
}
void px4_heading(ZLayerPx4 *p, double radians, double variance) {
    p->heading(radians, variance);
}
void px4_ground(ZLayerPx4 *p, double time, int at_rest, int in_air) {
    systemFlagUpdate flags{};
    flags.time_us = ZLayerPx4::clock(time);
    flags.at_rest = at_rest;
    flags.in_air = in_air;
    flags.is_fixed_wing = true;
    p->ekf.setSystemFlagData(flags);
}
double *px4_state(ZLayerPx4 *p) { return p->snapshot(); }
double *px4_covariance(ZLayerPx4 *p) {
    for (unsigned r = 0; r < State::size; ++r) {
        for (unsigned c = 0; c < State::size; ++c) { p->covariance[r*State::size+c] = p->ekf.stateCovariance(r,c); }
    }
    return p->covariance;
}
}
