const httpErrors = require("http-errors");
const mongoose = require("mongoose");
const moment = require("moment");

const {
  addCommentSchema,
  getPostsSchema,
  getPostByIdSchema,
  createPostSchema,
  deleteCommentSchema,
  deletePostSchema,
  likeUnlikeCommentSchema,
  likeUnlikePostSchema,
  updateCommentSchema,
  updatePostSchema,
} = require("./schema/posts");

/*
 * /api/posts
 */
async function routes(app) {
  const { mongo } = app;
  const Comment = mongo.model("Comment");
  const Post = mongo.model("Post");
  const User = mongo.model("User");

  // /posts

  app.get(
    "/",
    {
      preValidation: [app.authenticate],
      schema: getPostsSchema,
    },
    async (req) => {
      // const { userId } = req.body;
      const userId = mongoose.Types.ObjectId("5ea6900c0e0419d4cb123611");
      const [userErr, user] = await app.to(User.findById(userId));
      if (userErr) {
        throw app.httpErrors.notFound();
      }

      // TODO: add filters
      // TODO: add limitation of post content if user is not logged
      const [postsErr, posts] = await app.to(
        Post.aggregate([
          {
            $geoNear: {
              distanceField: "distance",
              key: "author.location.coordinates",
              near: {
                $geometry: {
                  coordinates: user.location.coordinates,
                  type: "Point",
                },
              },
              // query: { << add filters here >> }
            },
          },
          {
            $lookup: {
              as: "comments",
              foreignField: "postId",
              from: "comments",
              localField: "_id",
            },
          },
          {
            $project: {
              _id: true,
              commentsCount: {
                $size: "$comments",
              },
              content: true,
              distance: true,
              likesCount: {
                $size: "$likes",
              },
              name: "author.name",
              title: true,
              type: "author.type",
            },
          },
        ]),
      );

      if (postsErr) {
        req.log.error("Failed requesting posts", { postsErr });
        throw app.httpErrors.internalServerError();
      }

      return posts;
    },
  );

  app.post(
    "/",
    {
      preValidation: [app.authenticate],
      schema: createPostSchema,
    },
    async (req, reply) => {
      // const { userId } = req.body;
      const userId = mongoose.Types.ObjectId("5ea6900c0e0419d4cb123611");
      const [userErr, user] = await app.to(User.findById(userId));
      if (userErr) {
        throw app.httpErrors.notFound();
      }

      const { body: postProps } = req;

      // Creates embedded author document
      postProps.author = {
        id: user.id,
        location: user.location,
        name: `${user.firstName} ${user.lastName}`,
        type: user.type,
      };

      // ExpireAt needs to calculate the date
      postProps.expireAt = moment().add(1, `${postProps.expireAt}s`);

      // Initial empty likes array
      postProps.likes = [];

      const [err, post] = await app.to(new Post(postProps).save());

      if (err) {
        req.log.error("Failed creating post", { err });
        throw app.httpErrors.internalServerError();
      }

      reply.code(201);
      return post;
    },
  );

  // /posts/postId

  app.get(
    "/:postId",
    {
      preValidation: [app.authenticate],
      schema: getPostByIdSchema,
    },
    async (req) => {
      const { postId } = req.params;
      const [postErr, post] = await app.to(Post.findById(postId));
      if (postErr) {
        throw app.httpErrors.notFound();
      }

      // TODO: add pagination
      const [commentErr, commentQuery] = await app.to(
        Comment.aggregate([
          {
            $match: {
              parentId: null,
              postId: mongoose.Types.ObjectId(postId),
            },
          },
          {
            $lookup: {
              as: "children",
              foreignField: "parentId",
              from: "comments",
              localField: "_id",
            },
          },
          {
            $addFields: {
              childCount: {
                $size: { $ifNull: ["$children", []] },
              },
            },
          },
          {
            $group: {
              _id: null,
              comments: { $push: "$$ROOT" },
              numComments: { $sum: { $add: ["$childCount", 1] } },
            },
          },
        ]),
      );
      if (commentErr) {
        req.log.error("Failed retrieving comments", { commentErr });
        throw app.httpErrors.internalServerError();
      }

      const { comments = [], numComments = 0 } = commentQuery;

      return {
        comments,
        numComments,
        post,
      };
    },
  );

  app.delete(
    "/:postId",
    {
      preValidation: [app.authenticate],
      schema: deletePostSchema,
    },
    async (req) => {
      // const { userId } = req.body;
      const userId = mongoose.Types.ObjectId("5ea6900c0e0419d4cb123611");

      const { postId } = req.params;
      const [findErr, post] = await app.to(Post.findById(postId));
      if (findErr) {
        throw app.httpErrors.notFound();
      } else if (post.author.id !== userId) {
        throw app.httpErrors.forbidden();
      }

      const [deletePostErr, deletedCount] = await app.to(post.delete());
      if (deletePostErr) {
        req.log.error("Failed deleting post", { deletePostErr });
        throw app.httpErrors.internalServerError();
      }

      const {
        deletedCommentsCount,
        ok: deleteCommentsOk,
      } = await Comment.deleteMany({ postId });
      if (deleteCommentsOk !== 1) {
        app.log.error("failed removing comments for deleted post", { postId });
      }

      return { deletedCommentsCount, deletedCount, success: true };
    },
  );

  app.patch(
    "/:postId",
    {
      preValidation: [app.authenticate],
      schema: updatePostSchema,
    },
    async (req) => {
      // const { userId } = req.body;
      const userId = mongoose.Types.ObjectId("5ea6900c0e0419d4cb123611");

      const [err, post] = await app.to(Post.findById(req.params.postId));
      if (err) {
        throw app.httpErrors.notFound();
      } else if (post.author.id !== userId) {
        throw app.httpErrors.forbidden();
      }
      const { body } = req;

      // ExpireAt needs to calculate the date
      if (body.hasOwnProperty("expireAt")) {
        body.expireAt = moment().add(1, `${body.expireAt}s`);
      }

      const [updateErr, updatedPost] = await app.to(
        post.overwrite(body).save(),
      );

      if (updateErr) {
        req.log.error("Failed updating post", { updateErr });
        throw app.httpErrors.internalServerError();
      }

      return updatedPost;
    },
  );

  app.put(
    "/:postId/likes/:userId",
    {
      preValidation: [app.authenticate],
      schema: likeUnlikePostSchema,
    },
    async (req) => {
      const { postId, userId } = req.params;

      const [updateErr, updatedPost] = await app.to(
        Post.findOneAndUpdate(
          { _id: postId },
          { $addToSet: { likes: userId } },
          { new: true },
        ),
      );
      if (updateErr) {
        throw app.httpErrors.notFound();
      }

      return {
        likes: updatedPost.likes,
        likesCount: updatedPost.likes.length,
      };
    },
  );

  app.delete(
    "/:postId/likes/:userId",
    {
      preValidation: [app.authenticate],
      schema: likeUnlikePostSchema,
    },
    async (req) => {
      const { postId, userId } = req.params;

      const [updateErr, updatedPost] = await app.to(
        Post.findOneAndUpdate(
          { _id: postId },
          { $pull: { likes: userId } },
          { new: true },
        ),
      );
      if (updateErr) {
        throw app.httpErrors.notFound();
      }

      return {
        likes: updatedPost.likes,
        likesCount: updatedPost.likes.length,
      };
    },
  );

  app.post(
    "/:postId/comments",
    { preValidation: [app.authenticate], schema: addCommentSchema },
    async (req) => {
      const { body, params, userId } = req;
      const { parentId } = body;
      const { postId } = params;
      if (parentId) {
        const parentPost = await Post.findById(parentId);
        if (!parentPost || parentPost.postId !== postId) {
          return new httpErrors.BadRequest();
        }
      }
      return new Comment({
        ...body,
        authorId: userId,
        postId,
      }).save();
    },
  );

  app.put(
    "/:postId/comments/:commentId",
    { preValidation: [app.authenticate], schema: updateCommentSchema },
    async (req) => {
      const { body, params, userId } = req;
      const { comment } = body;
      const { commentId, postId } = params;
      const updatedComment = await Comment.findOneAndUpdate(
        { _id: commentId, authorId: userId, postId },
        { comment },
        { new: true },
      );
      if (!updatedComment) {
        return new httpErrors.BadRequest();
      }
      return updatedComment;
    },
  );

  app.delete(
    "/:postId/comments/:commentId",
    { preValidation: [app.authenticate], schema: deleteCommentSchema },
    async (req) => {
      const { params, userId } = req;
      const { commentId, postId } = params;
      const { ok, deletedCount } = await Comment.deleteMany({
        $or: [
          { _id: commentId, authorId: userId, postId },
          { parentId: commentId, postId },
        ],
      });
      if (ok !== 1 || deletedCount < 1) {
        return new httpErrors.BadRequest();
      }
      return { deletedCount, success: true };
    },
  );

  app.put(
    "/:postId/comments/:commentId/likes/:userId",
    { preValidation: [app.authenticate], schema: likeUnlikeCommentSchema },
    async (req) => {
      const { commentId, postId, userId } = req.params;
      if (userId !== req.userId) {
        return new httpErrors.Forbidden();
      }
      const updatedComment = await Comment.findOneAndUpdate(
        { _id: commentId, likes: { $ne: userId }, postId },
        { $inc: { likesCount: 1 }, $push: { likes: userId } },
        { new: true },
      );
      if (!updatedComment) {
        return new httpErrors.BadRequest();
      }

      return {
        likes: updatedComment.likes,
        likesCount: updatedComment.likesCount,
      };
    },
  );

  app.delete(
    "/:postId/comments/:commentId/likes/:userId",
    { preValidation: [app.authenticate], schema: likeUnlikeCommentSchema },
    async (req) => {
      const {
        params: { commentId, postId },
        userId,
      } = req;
      const updatedComment = await Comment.findOneAndUpdate(
        { _id: commentId, likes: userId, postId },
        { $inc: { likesCount: -1 }, $pull: { likes: userId } },
        { new: true },
      );
      if (!updatedComment) {
        return new httpErrors.BadRequest();
      }

      return {
        likes: updatedComment.likes,
        likesCount: updatedComment.likesCount,
      };
    },
  );
}

module.exports = routes;
